-- Disclaimer: I didn't write this and honestly don't remember where
-- I copied it from. Been using it for a while as test SQL.

create schema if not exists my_schema;

-----------------------------------------------------
-----------------------------------------------------
-----------------------------------------------------
-----------------------------------------------------
-- Dates

drop table if exists my_schema.dates cascade;
create table my_schema.dates
(
    date_id                int,
    date                   date unique,
    epoch                  bigint,
    day_suffix             varchar(4),
    day_name               varchar(9),
    day_of_week            int,
    day_of_month           int,
    day_of_quarter         int,
    day_of_year            int,
    week_of_month          int,
    week_of_year           int,
    week_of_year_iso       char(10),
    month_actual           int,
    month_name             varchar(9),
    month_name_abbreviated char(3),
    quarter_actual         int,
    quarter_name           varchar(9),
    year_actual            int,
    first_day_of_week      date,
    last_day_of_week       date,
    first_day_of_month     date,
    last_day_of_month      date,
    first_day_of_quarter   date,
    last_day_of_quarter    date,
    first_day_of_year      date,
    last_day_of_year       date,
    mmyyyy                 char(6),
    mmddyyyy               char(10),
    weekend_indr           boolean,
    primary key (date_id)
);

insert into my_schema.dates
select to_char(datum, 'yyyymmdd')::int                                                        as date_id, datum as date,
       extract(epoch from datum)                                                              as epoch,
       to_char(datum, 'fmDDth')                                                               as day_suffix,
       to_char(datum, 'TMDay')                                                                as day_name,
       extract(isodow from datum)                                                             as day_of_week,
       extract(day from datum)                                                                as day_of_month,
       datum - date_trunc('quarter', datum)::date + 1                                         as day_of_quarter,
       extract(doy from datum)                                                                as day_of_year,
       to_char(datum, 'W')::int                                                               as week_of_month,
       extract(week from datum)                                                               as week_of_year,
       extract(isoyear from datum) || to_char(datum, '"-W"IW-') || extract(isodow from datum) as week_of_year_iso,
       extract(month from datum)                                                              as month_actual,
       to_char(datum, 'TMMonth')                                                              as month_name,
       to_char(datum, 'Mon')                                                                  as month_name_abbreviated,
       extract(quarter from datum)                                                            as quarter_actual,
       case
           when extract(quarter from datum) = 1 then 'First'
           when extract(quarter from datum) = 2 then 'Second'
           when extract(quarter from datum) = 3 then 'Third'
           when extract(quarter from datum) = 4 then 'Fourth'
end
as quarter_name,
       extract(year from datum)                                                               as year_actual,
       datum + (1 - extract(isodow from datum))::int                                          as first_day_of_week,
       datum + (7 - extract(isodow from datum))::int                                          as last_day_of_week,
       datum + (1 - extract(day from datum))::int                                             as first_day_of_month,
       (date_trunc('month', datum) + interval '1 month - 1 day')::date                        as last_day_of_month,
       date_trunc('quarter', datum)::date                                                     as first_day_of_quarter,
       (date_trunc('quarter', datum) + interval '3 month - 1 day')::date                      as last_day_of_quarter,
       to_date(extract(year from datum) || '-01-01', 'YYYY-MM-DD')                            as first_day_of_year,
       to_date(extract(year from datum) || '-12-31', 'YYYY-MM-DD')                            as last_day_of_year,
       to_char(datum, 'mmyyyy')                                                               as mmyyyy,
       to_char(datum, 'mmddyyyy')                                                             as mmddyyyy,
       case
           when extract(isodow from datum) in (6, 7) then true
           else false
end
as weekend_indr
from (select '1970-01-01'::date + sequence.day as datum
      from generate_series(0, 29219) as sequence (day)
      group by sequence.day) dq
order by 1;