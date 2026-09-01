-- TypTap backend schema (self-hosted Postgres).
-- Один профиль = один никнейм (без пароля, как в исходном приложении).
-- Полный "снимок" клиентского объекта store (sessions, streak, completed,
-- xp и все динамические поля мини-игр вроде bestClimb/bossWins/...) хранится
-- целиком в jsonb-колонке `data`, чтобы бэкенд не ломался каждый раз, когда во
-- фронтенде добавляется новое поле статистики.
--
-- Отдельные колонки best_wpm/best_acc/streak_count/xp — денормализованные
-- значения, вычисляемые API из `data` при каждом сохранении. Они нужны только
-- для быстрой сортировки в лидерборде (по jsonb сортировать эффективно нельзя,
-- а тут — обычный индекс).

create table if not exists public.profiles (
  nickname     text primary key,
  data         jsonb not null default '{}'::jsonb,
  best_wpm     integer not null default 0,
  best_acc     numeric(5,2) not null default 0,
  streak_count integer not null default 0,
  xp           bigint not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint nickname_len check (char_length(nickname) between 1 and 20)
);

create index if not exists profiles_best_wpm_idx     on public.profiles (best_wpm desc);
create index if not exists profiles_best_acc_idx     on public.profiles (best_acc desc);
create index if not exists profiles_streak_count_idx on public.profiles (streak_count desc);

-- Автообновление updated_at при каждом UPDATE.
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();
