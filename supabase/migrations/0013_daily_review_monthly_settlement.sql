update public.daily_reviews
set status = 'approved'
where status = 'paid';

alter table public.daily_reviews
drop constraint if exists daily_reviews_status_check;

alter table public.daily_reviews
add constraint daily_reviews_status_check
check (status in ('pending_review', 'approved', 'problem'));
