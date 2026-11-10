-- Supabase Dashboard → SQL Editor ထဲမှာ ဒီဖိုင်တစ်ခုလုံး Run ပါ
-- (အရင် run ပြီးသားဆိုလည်း ထပ် run လို့ရပါတယ်၊ data မပျက်ပါဘူး)

create table if not exists users(
  id bigint primary key,
  coins int not null default 0,
  referred_by bigint,
  rewarded int not null default 0,
  welcomed int not null default 0,
  last_daily text,
  last_qr text
);

create table if not exists keys(
  id bigserial primary key,
  key text,
  version text,
  uses int not null default 0,
  file_id text,
  file_name text,
  kind text
);

-- အရင် table ရှိပြီးသားဆိုရင် column အသစ်တွေ ထည့်မယ်
alter table users add column if not exists last_qr text;
alter table keys  add column if not exists kind text;

create index if not exists keys_version_idx on keys(version, uses);

create table if not exists claims(
  user_id bigint,
  key_id bigint,
  primary key(user_id, key_id)
);

create table if not exists settings(
  name text primary key,
  value text
);

-- Public (anon) API ကနေ ဖတ်/ရေးမရအောင် RLS ဖွင့်ထားမယ်။
-- Worker က service_role key သုံးတာမို့ RLS ကို ကျော်လို့ရတယ်။
alter table users    enable row level security;
alter table keys     enable row level security;
alter table claims   enable row level security;
alter table settings enable row level security;

-- ---------------- Functions ----------------

-- Function အဟောင်းတွေ (parameter နာမည်/အရေအတွက် ကွဲနေတာတွေပါ) အကုန်ဖျက်ပြီးမှ အသစ်ပြန်ဆောက်မယ်
do $$
declare r record;
begin
  for r in
    select oid::regprocedure as sig from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname in ('ensure_user','activate_user','claim_daily',
                       'add_coins','menu_data','buy_key')
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

create or replace function ensure_user(p_uid bigint, p_ref bigint default null)
returns void language sql as $$
  insert into users(id, referred_by) values (p_uid, p_ref)
  on conflict (id) do nothing;
$$;

-- Channel join ပြီးမှ ခေါ်မယ်: referrer reward + welcome coin (တစ်ကြိမ်ပဲ)
create or replace function activate_user(p_uid bigint, p_welcome int, p_ref_reward int)
returns json language plpgsql as $$
declare
  v_ref bigint;
  v_n int;
begin
  insert into users(id) values (p_uid) on conflict (id) do nothing;

  update users set rewarded = 1
   where id = p_uid and rewarded = 0 and referred_by is not null
  returning referred_by into v_ref;

  if v_ref is not null then
    update users set coins = coins + p_ref_reward where id = v_ref;
  end if;

  update users set welcomed = 1, coins = coins + p_welcome
   where id = p_uid and welcomed = 0;
  get diagnostics v_n = row_count;

  return json_build_object('bonus', v_n = 1, 'referrer', v_ref);
end $$;

create or replace function claim_daily(p_uid bigint, p_coin int, p_today text)
returns json language plpgsql as $$
declare
  v_n int;
  v_coins int;
begin
  insert into users(id) values (p_uid) on conflict (id) do nothing;

  update users set coins = coins + p_coin, last_daily = p_today
   where id = p_uid and (last_daily is null or last_daily <> p_today);
  get diagnostics v_n = row_count;

  select coins into v_coins from users where id = p_uid;
  return json_build_object('ok', v_n = 1, 'coins', v_coins);
end $$;

create or replace function add_coins(p_uid bigint, p_amt int)
returns void language plpgsql as $$
begin
  insert into users(id) values (p_uid) on conflict (id) do nothing;
  update users set coins = coins + p_amt where id = p_uid;
end $$;

-- Menu ပြဖို့ လိုတာအကုန် တစ်ခါတည်း ယူမယ် (QR ပုံပါတဲ့ row တွေပဲ ရေတွက်မယ်)
create or replace function menu_data(p_uid bigint, p_max int)
returns json language plpgsql as $$
declare
  v_coins int;
  v_last text;
begin
  insert into users(id) values (p_uid) on conflict (id) do nothing;
  select coins, last_qr into v_coins, v_last from users where id = p_uid;

  return json_build_object(
    'coins', v_coins,
    'last_qr', v_last,
    'new', (select coalesce(sum(p_max - uses), 0) from keys
             where version = 'new' and file_id is not null and uses < p_max),
    'old', (select coalesce(sum(p_max - uses), 0) from keys
             where version = 'old' and file_id is not null and uses < p_max),
    'open', (select value from settings where name = 'open'),
    'release_at', (select value from settings where name = 'release_at'),
    'users', (select count(*) from users)
  );
end $$;

-- QR ထုတ်: တစ်နေ့ ၁ ခု စစ် + coin စစ် + QR ရွေး + uses တိုး + claim မှတ် + coin နှုတ် (အားလုံး atomic)
create or replace function buy_key(
  p_uid bigint, p_version text, p_price int, p_max int, p_today text)
returns json language plpgsql as $$
declare
  v_coins int;
  v_last text;
  v_key keys%rowtype;
begin
  insert into users(id) values (p_uid) on conflict (id) do nothing;

  -- user row ကို lock ချလို့ တစ်ယောက်တည်း ၂ ခါဆက်နှိပ်ရင်လည်း မထပ်ပေးမိဘူး
  select coins, last_qr into v_coins, v_last from users where id = p_uid for update;

  if v_last = p_today then
    return json_build_object('status', 'limit');
  end if;
  if v_coins < p_price then
    return json_build_object('status', 'no_coins');
  end if;

  select * into v_key from keys
   where version = p_version and file_id is not null and uses < p_max
     and id not in (select key_id from claims where user_id = p_uid)
   order by uses desc, id
   limit 1
   for update skip locked;

  if not found then
    return json_build_object('status', 'sold_out');
  end if;

  update keys set uses = uses + 1 where id = v_key.id;
  insert into claims(user_id, key_id) values (p_uid, v_key.id);
  update users set coins = coins - p_price, last_qr = p_today where id = p_uid;

  return json_build_object(
    'status', 'ok',
    'file_id', v_key.file_id,
    'kind', coalesce(v_key.kind, 'photo'));
end $$;

-- Function အသစ်တွေကို API က ချက်ချင်းမြင်အောင်
notify pgrst, 'reload schema';
