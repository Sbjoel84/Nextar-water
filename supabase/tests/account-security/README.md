# Account security tests

Builds the whole database from `supabase/migrations` (in order, as Supabase would) on top of
`stub.sql`, a stand-in for the Supabase platform: the `anon` / `authenticated` / `service_role`
roles, `auth.users` + `auth.uid()`, the `storage` schema, and Supabase's real default privileges
(every new table and function in `public` is granted to `anon` and `authenticated`, so anything a
migration forgets to lock down shows up here exactly as it would in production).

`attack.mjs` then signs in as real users and tries the exploits that
`20261018090000_account_security_hardening.sql` closes:

- logged-out visitors reading tables or calling functions
- users editing their own profile status, production scope or requested role
- suspended users keeping access through leftover permission overrides
- staff with user-admin overrides granting `super_admin` / `chairman`, or suspending or deleting
  those accounts; anyone changing their own status or deleting their own account
- forging audit-log rows in someone else's name

It also checks that every `supabase.rpc("...")` the app makes (scanned from `src/`) is still
callable by signed-in users, so a lock-down can't silently break a page.

Runs on PGlite (real Postgres in WebAssembly), so no Docker is needed:

    mkdir /tmp/acct && cd /tmp/acct && npm init -y && npm i @electric-sql/pglite@0.2.17
    cp <repo>/supabase/tests/account-security/{stub.sql,build.mjs,attack.mjs} .
    node build.mjs <repo>/supabase/migrations ./pgdata
    node attack.mjs ./pgdata <repo>/src

The second argument is the app's `src/` folder, scanned for RPC names.

Expected result: every migration applies and all checks pass. Against the migrations before the
hardening migration, 18 of the checks fail.
