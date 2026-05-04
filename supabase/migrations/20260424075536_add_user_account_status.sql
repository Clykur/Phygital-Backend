alter table public.users
add column if not exists account_status text not null default 'active';

update public.users
set account_status = 'active'
where account_status is null or account_status = '';