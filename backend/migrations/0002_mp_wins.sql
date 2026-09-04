-- Мультиплеер: счётчик побед в MP-гонках для отдельного лидерборда.
-- Идемпотентно (безопасно при каждом старте контейнера).
alter table public.profiles add column if not exists mp_wins int not null default 0;
create index if not exists profiles_mp_wins_idx on public.profiles (mp_wins desc);
