-- User roles table (must be separate from users/profile per security rules)
create type public.app_role as enum ('admin', 'moderator', 'user');

create table public.user_roles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade not null,
    role app_role not null,
    unique (user_id, role)
);

grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;

alter table public.user_roles enable row level security;

create policy "Users can read own roles"
    on public.user_roles
    for select
    to authenticated
    using (user_id = auth.uid());

-- Security definer helper to check roles
create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = _user_id
      and role = _role
  );
$$;

-- Profiles table
create table public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    username text unique,
    full_name text,
    avatar_url text,
    timezone text default 'UTC',
    plan text default 'free',
    created_at timestamp with time zone default now(),
    updated_at timestamp with time zone default now()
);

grant select, insert, update, delete on public.profiles to authenticated;
grant all on public.profiles to service_role;

alter table public.profiles enable row level security;

create policy "Users can manage own profile"
    on public.profiles
    for all
    to authenticated
    using (id = auth.uid())
    with check (id = auth.uid());

create policy "Admins can manage all profiles"
    on public.profiles
    for all
    to authenticated
    using (public.has_role(auth.uid(), 'admin'));

-- Currency pairs
create table public.currency_pairs (
    id uuid primary key default gen_random_uuid(),
    symbol text unique not null,
    name text not null,
    active boolean default true,
    category text default 'major',
    default_timeframe text default 'M5',
    sort_order integer default 0,
    created_at timestamp with time zone default now()
);

grant select on public.currency_pairs to anon;
grant select, insert, update, delete on public.currency_pairs to authenticated;
grant all on public.currency_pairs to service_role;

alter table public.currency_pairs enable row level security;

create policy "Currency pairs are readable by everyone"
    on public.currency_pairs
    for select
    to anon, authenticated
    using (true);

create policy "Admins can manage currency pairs"
    on public.currency_pairs
    for all
    to authenticated
    using (public.has_role(auth.uid(), 'admin'));

-- Signals
create type public.signal_direction as enum ('CALL', 'PUT');
create type public.signal_status as enum ('active', 'expired', 'won', 'lost');

create table public.signals (
    id uuid primary key default gen_random_uuid(),
    pair_id uuid references public.currency_pairs(id) on delete set null,
    direction signal_direction not null,
    timeframe text default 'M5',
    entry_price numeric,
    expiration_minutes integer default 5,
    confidence integer check (confidence >= 0 and confidence <= 100),
    status signal_status default 'active',
    analysis_summary text,
    created_at timestamp with time zone default now(),
    expired_at timestamp with time zone,
    resulted_at timestamp with time zone
);

grant select on public.signals to anon;
grant select, insert, update, delete on public.signals to authenticated;
grant all on public.signals to service_role;

alter table public.signals enable row level security;

create policy "Signals are readable by everyone"
    on public.signals
    for select
    to anon, authenticated
    using (true);

create policy "Admins and moderators can manage signals"
    on public.signals
    for all
    to authenticated
    using (public.has_role(auth.uid(), 'admin') or public.has_role(auth.uid(), 'moderator'));

-- Signal results
create type public.signal_result_outcome as enum ('win', 'loss', 'draw');

create table public.signal_results (
    id uuid primary key default gen_random_uuid(),
    signal_id uuid references public.signals(id) on delete cascade,
    exit_price numeric,
    result signal_result_outcome,
    pips numeric,
    verified_at timestamp with time zone default now()
);

grant select on public.signal_results to anon;
grant select, insert, update, delete on public.signal_results to authenticated;
grant all on public.signal_results to service_role;

alter table public.signal_results enable row level security;

create policy "Signal results are readable by everyone"
    on public.signal_results
    for select
    to anon, authenticated
    using (true);

create policy "Admins and moderators can manage signal results"
    on public.signal_results
    for all
    to authenticated
    using (public.has_role(auth.uid(), 'admin') or public.has_role(auth.uid(), 'moderator'));

-- User favorite pairs
create table public.user_favorites (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade not null,
    pair_id uuid references public.currency_pairs(id) on delete cascade not null,
    created_at timestamp with time zone default now(),
    unique (user_id, pair_id)
);

grant select, insert, delete on public.user_favorites to authenticated;
grant all on public.user_favorites to service_role;

alter table public.user_favorites enable row level security;

create policy "Users manage own favorites"
    on public.user_favorites
    for all
    to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

-- User settings
create table public.user_settings (
    id uuid primary key references auth.users(id) on delete cascade,
    email_notifications boolean default true,
    push_notifications boolean default true,
    risk_per_trade integer default 2,
    default_expiration integer default 5,
    created_at timestamp with time zone default now(),
    updated_at timestamp with time zone default now()
);

grant select, insert, update on public.user_settings to authenticated;
grant all on public.user_settings to service_role;

alter table public.user_settings enable row level security;

create policy "Users manage own settings"
    on public.user_settings
    for all
    to authenticated
    using (id = auth.uid())
    with check (id = auth.uid());

-- Subscriptions
create type public.subscription_status as enum ('active', 'canceled', 'past_due', 'expired');

create table public.subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade not null,
    plan text default 'free',
    status subscription_status default 'active',
    started_at timestamp with time zone default now(),
    expires_at timestamp with time zone,
    created_at timestamp with time zone default now(),
    updated_at timestamp with time zone default now()
);

grant select on public.subscriptions to authenticated;
grant all on public.subscriptions to service_role;

alter table public.subscriptions enable row level security;

create policy "Users can read own subscriptions"
    on public.subscriptions
    for select
    to authenticated
    using (user_id = auth.uid());

create policy "Admins can manage subscriptions"
    on public.subscriptions
    for all
    to authenticated
    using (public.has_role(auth.uid(), 'admin'));

-- Seed currency pairs
insert into public.currency_pairs (symbol, name, category, default_timeframe, sort_order) values
    ('EUR/USD', 'Euro / US Dollar', 'major', 'M5', 1),
    ('GBP/USD', 'British Pound / US Dollar', 'major', 'M5', 2),
    ('USD/JPY', 'US Dollar / Japanese Yen', 'major', 'M5', 3),
    ('USD/CHF', 'US Dollar / Swiss Franc', 'major', 'M5', 4),
    ('AUD/USD', 'Australian Dollar / US Dollar', 'major', 'M5', 5),
    ('USD/CAD', 'US Dollar / Canadian Dollar', 'major', 'M5', 6),
    ('NZD/USD', 'New Zealand Dollar / US Dollar', 'major', 'M5', 7),
    ('EUR/GBP', 'Euro / British Pound', 'minor', 'M5', 8),
    ('EUR/JPY', 'Euro / Japanese Yen', 'minor', 'M5', 9),
    ('GBP/JPY', 'British Pound / Japanese Yen', 'minor', 'M5', 10),
    ('BTC/USD', 'Bitcoin / US Dollar', 'crypto', 'M15', 11),
    ('ETH/USD', 'Ethereum / US Dollar', 'crypto', 'M15', 12);

-- Seed a few recent signals for demo
insert into public.signals (pair_id, direction, timeframe, entry_price, expiration_minutes, confidence, status, analysis_summary, created_at, expired_at)
select
    cp.id,
    (array['CALL'::public.signal_direction, 'PUT'::public.signal_direction])[floor(random() * 2 + 1)] as direction,
    'M5',
    round((random() * 2 + 1)::numeric, 5),
    5,
    floor(random() * 20 + 70)::int,
    'active',
    'Demo signal generated for initial setup',
    now() - (random() * interval '24 hours'),
    now() - (random() * interval '24 hours') + interval '5 minutes'
from public.currency_pairs cp
where cp.symbol in ('EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD')
order by random()
limit 8;
