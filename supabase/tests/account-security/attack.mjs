// Account-security suite: runs exploits as real Supabase roles (anon /
// authenticated) against a copy of the database build.mjs made. See README.md.
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const src = process.argv[2];
const work = src + "-attack";
fs.rmSync(work, { recursive: true, force: true });
fs.cpSync(src, work, { recursive: true });
const db = new PGlite(work);

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? "  -> " + extra : ""}`);
};
const q = async (sql, p) => (await db.query(sql, p)).rows;

// Run one statement as a user (uid) or as anon (uid = null). Returns {rows} or {error}.
async function as(uid, sql, params = []) {
  await db.exec("BEGIN");
  try {
    const claims = uid ? { sub: uid, role: "authenticated" } : { role: "anon" };
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await db.exec(`SET LOCAL ROLE ${uid ? "authenticated" : "anon"}`);
    const r = await db.query(sql, params);
    await db.exec("COMMIT");
    return { rows: r.rows, n: r.affectedRows };
  } catch (e) {
    await db.exec("ROLLBACK");
    return { error: e.message };
  }
}
const denied = (r) => !!r.error || r.n === 0;

const F = (await q("SELECT id FROM factories LIMIT 1"))[0].id;
const mkUser = async (email, meta = {}) =>
  (
    await q("INSERT INTO auth.users(email, raw_user_meta_data) VALUES ($1, $2) RETURNING id", [
      email,
      JSON.stringify(meta),
    ])
  )[0].id;

const admin = await mkUser("admin@x.test"); // first user -> super_admin, active
const chair = await mkUser("chair@x.test");
const mgr = await mkUser("mgr@x.test");
const cashier = await mkUser("cashier@x.test");
const pend = await mkUser("pend@x.test", { role_requested: "cashier" });
const susp = await mkUser("susp@x.test");
for (const u of [chair, mgr, cashier, susp])
  await q("UPDATE profiles SET status='active' WHERE id=$1", [u]);
await q(
  "INSERT INTO user_roles(user_id, role) VALUES ($1,'chairman'),($2,'accountant'),($3,'cashier'),($4,'cashier')",
  [chair, mgr, cashier, susp],
);
// mgr is ordinary staff who was handed user-admin powers through overrides
for (const [m, a] of [
  ["account-approvals", "create"],
  ["account-approvals", "edit"],
  ["users", "approve"],
  ["users", "post"],
  ["users", "submit"],
  ["users", "edit"],
])
  await q(
    "INSERT INTO permission_overrides(user_id, module, action, granted) VALUES ($1,$2,$3,true)",
    [mgr, m, a],
  );
// susp had an override, then got suspended (roles stripped as set_user_status does)
await q(
  "INSERT INTO permission_overrides(user_id, module, action, granted) VALUES ($1,'customers','create',true),($1,'users','edit',true)",
  [susp],
);
await q("UPDATE profiles SET status='suspended' WHERE id=$1", [susp]);
await q("DELETE FROM user_roles WHERE user_id=$1", [susp]);
const role = async (u) =>
  (await q("SELECT array_agg(role ORDER BY role) r FROM user_roles WHERE user_id=$1", [u]))[0].r;
const status = async (u) => (await q("SELECT status FROM profiles WHERE id=$1", [u]))[0].status;

console.log("\n[logged-out visitor]");
for (const t of [
  "profiles",
  "customers",
  "sales",
  "user_roles",
  "audit_logs",
  "settings",
  "permission_overrides",
  "employees",
])
  ok(`anon cannot read ${t}`, !!(await as(null, `SELECT 1 FROM public.${t} LIMIT 1`)).error);
ok("anon can read roles (signup page)", !(await as(null, "SELECT slug FROM roles")).error);
ok("anon cannot call create_sale", !!(await as(null, "SELECT create_sale('{}'::jsonb)")).error);
ok(
  "anon cannot call get_my_permissions",
  !!(await as(null, "SELECT * FROM get_my_permissions()")).error,
);
ok(
  "anon cannot insert audit log",
  !!(await as(null, "INSERT INTO audit_logs(action) VALUES ('x')")).error,
);

console.log("\n[own profile]");
ok(
  "pending user cannot activate self",
  denied(await as(pend, "UPDATE profiles SET status='active' WHERE id=$1", [pend])) &&
    (await status(pend)) === "pending",
);
ok(
  "cashier cannot widen own production scope",
  denied(await as(cashier, "UPDATE profiles SET production_scope='BOTH' WHERE id=$1", [cashier])),
);
ok(
  "pending user cannot change requested role",
  denied(await as(pend, "UPDATE profiles SET role_requested='super_admin' WHERE id=$1", [pend])),
);
ok(
  "user cannot insert a profile",
  !!(await as(cashier, "INSERT INTO profiles(id, email) VALUES (gen_random_uuid(), 'z@z')")).error,
);
const own = await as(
  cashier,
  "UPDATE profiles SET avatar_url='a.png', username='cash1' WHERE id=$1",
  [cashier],
);
ok("user CAN still update own avatar/username", !own.error && own.n === 1, own.error);
ok(
  "user cannot update another profile",
  denied(await as(cashier, "UPDATE profiles SET username='hacked' WHERE id=$1", [mgr])),
);
const team = await as(cashier, "SELECT count(*)::int c FROM profiles");
ok("active staff CAN read team profiles", !team.error && team.rows[0].c >= 5, JSON.stringify(team));
const pteam = await as(pend, "SELECT count(*)::int c FROM profiles");
ok(
  "pending sign-up sees only own profile",
  !pteam.error && pteam.rows[0].c === 1,
  JSON.stringify(pteam),
);

console.log("\n[suspended user with leftover overrides]");
ok(
  "has_permission false for suspended override",
  (
    await q("SELECT has_permission($1::uuid,'customers'::module_key,'create'::action_key) v", [
      susp,
    ])
  )[0].v === false,
);
const gp = await as(susp, "SELECT count(*)::int c FROM get_my_permissions()");
ok("get_my_permissions empty for suspended", !gp.error && gp.rows[0].c === 0, JSON.stringify(gp));
ok(
  "suspended cannot insert customer",
  !!(await as(susp, "INSERT INTO customers(factory_id, name) VALUES ($1,'x')", [F])).error,
);
ok(
  "active override still works (mgr users:edit)",
  (await q("SELECT has_permission($1::uuid,'users'::module_key,'edit'::action_key) v", [mgr]))[0]
    .v === true,
);

console.log("\n[staff escalation]");
const ap = await as(mgr, "SELECT approve_user($1, 'super_admin', NULL)", [pend]);
ok(
  "override holder cannot approve someone as super_admin",
  !!ap.error && !(await role(pend)),
  ap.error,
);
const ap2 = await as(mgr, "SELECT approve_user($1, 'cashier', NULL)", [pend]);
ok(
  "override holder CAN approve as cashier",
  !ap2.error && (await role(pend))?.includes("cashier"),
  ap2.error,
);
const susChair = await as(mgr, "SELECT set_user_status($1, 'suspended')", [chair]);
ok(
  "staff cannot suspend the chairman",
  !!susChair.error && (await status(chair)) === "active",
  susChair.error,
);
const delChair = await as(mgr, "SELECT delete_user_account($1)", [chair]);
ok(
  "staff cannot delete the chairman",
  !!delChair.error && (await status(chair)) === "active",
  delChair.error,
);
const selfSus = await as(mgr, "SELECT set_user_status($1, 'suspended')", [mgr]);
ok(
  "nobody can change own status",
  !!selfSus.error && (await status(mgr)) === "active",
  selfSus.error,
);
const selfDel = await as(mgr, "SELECT delete_user_account($1)", [mgr]);
ok(
  "nobody can delete own account",
  !!selfDel.error && (await status(mgr)) === "active",
  selfDel.error,
);
const susCash = await as(mgr, "SELECT set_user_status($1, 'suspended')", [cashier]);
ok(
  "staff CAN suspend an ordinary user",
  !susCash.error && (await status(cashier)) === "suspended",
  susCash.error,
);
await q("UPDATE profiles SET status='active' WHERE id=$1", [cashier]);
await q("INSERT INTO user_roles(user_id, role) VALUES ($1,'cashier') ON CONFLICT DO NOTHING", [
  cashier,
]);
const rq = await as(mgr, "SELECT request_role_grant($1, 'chairman', NULL)", [cashier]);
if (!rq.error) {
  const id = rq.rows[0].request_role_grant.id;
  await as(chair, "SELECT approve_role_grant($1, 'ok')", [id]);
  const post = await as(mgr, "SELECT post_role_grant($1, 'go')", [id]);
  ok(
    "staff cannot post a chairman role grant",
    !!post.error && !(await role(cashier)).includes("chairman"),
    post.error,
  );
} else ok("request_role_grant ran", false, rq.error);
const chApprove = await as(chair, "SELECT admin_set_user_role($1, 'super_admin')", [cashier]);
ok(
  "chairman CAN assign super_admin",
  !chApprove.error && (await role(cashier)).includes("super_admin"),
  chApprove.error,
);

console.log("\n[chairman cannot be removed]");
const chSus = await as(admin, "SELECT set_user_status($1, 'suspended')", [chair]);
ok(
  "super_admin cannot suspend chairman",
  !!chSus.error && (await status(chair)) === "active",
  chSus.error,
);
ok(
  "super_admin cannot delete chairman",
  !!(await as(admin, "SELECT delete_user_account($1)", [chair])).error &&
    (await status(chair)) === "active",
);
ok(
  "super_admin cannot demote chairman",
  !!(await as(admin, "SELECT admin_set_user_role($1, 'cashier')", [chair])).error &&
    (await role(chair)).includes("chairman"),
);
ok(
  "super_admin cannot strip the chairman role directly",
  denied(await as(admin, "DELETE FROM user_roles WHERE user_id=$1 AND role='chairman'", [chair])) &&
    (await role(chair)).includes("chairman"),
);
ok(
  "super_admin cannot edit the chairman's profile",
  !!(await as(admin, "SELECT admin_update_profile($1, 'Renamed')", [chair])).error,
);
ok(
  "super_admin cannot make someone chairman",
  !!(await as(admin, "SELECT admin_set_user_role($1, 'chairman')", [mgr])).error &&
    !(await role(mgr)).includes("chairman"),
);
ok(
  "chairman cannot delete own account either",
  !!(await as(chair, "SELECT delete_user_account($1)", [chair])).error,
);
const chEditSelf = await as(chair, "SELECT admin_update_profile($1, 'The Chairman')", [chair]);
ok("chairman CAN edit own profile", !chEditSelf.error, chEditSelf.error);

console.log("\n[chairman needs no approvals]");
const prod = (
  await q(
    "INSERT INTO products(factory_id, name, unit, unit_price, cost_price, current_stock) VALUES ($1,'Test water','pack',100,60,50) RETURNING id",
    [F],
  )
)[0].id;
const chSale = await as(chair, "SELECT create_sale($1)", [
  JSON.stringify({
    factory_id: F,
    customer_name: "Walk-in",
    payments: [{ method: "cash", amount: 300 }],
    items: [{ product_id: prod, quantity: 3, unit_price: 100 }],
  }),
]);
const saleId = chSale.rows?.[0]?.create_sale?.sale_id ?? chSale.rows?.[0]?.create_sale?.id;
const saleRow = saleId ? (await q("SELECT status FROM sales WHERE id=$1", [saleId]))[0] : null;
ok(
  "chairman's sale is posted on save",
  saleRow?.status === "posted",
  chSale.error ?? saleRow?.status,
);
ok(
  "chairman's sale took stock",
  Number((await q("SELECT current_stock FROM products WHERE id=$1", [prod]))[0].current_stock) ===
    47,
);
const salePay = saleId
  ? await q("SELECT status FROM payments_received WHERE sale_id=$1", [saleId])
  : [];
ok(
  "chairman's sale payment is confirmed",
  salePay.length > 0 && salePay.every((p) => p.status === "confirmed"),
  JSON.stringify(salePay),
);

const staffSale = await as(admin, "SELECT create_sale($1)", [
  JSON.stringify({
    factory_id: F,
    customer_name: "Walk-in",
    items: [{ product_id: prod, quantity: 1, unit_price: 100 }],
  }),
]);
const staffSaleId =
  staffSale.rows?.[0]?.create_sale?.sale_id ?? staffSale.rows?.[0]?.create_sale?.id;
ok(
  "someone else's sale still waits for approval",
  staffSaleId &&
    (await q("SELECT status FROM sales WHERE id=$1", [staffSaleId]))[0].status ===
      "pending_approval",
  staffSale.error,
);

// Make posting fail for one marked sale, to check the chairman's entry is
// kept (pending, with a notification) rather than lost.
await q(`CREATE FUNCTION pg_temp_fail_post() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.remarks = 'FAILTEST' AND NEW.status = 'posted' THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END $$`);
await q(
  "CREATE TRIGGER zz_fail_post BEFORE UPDATE ON sales FOR EACH ROW EXECUTE FUNCTION pg_temp_fail_post()",
);
const failing = await as(chair, "SELECT create_sale($1)", [
  JSON.stringify({
    factory_id: F,
    customer_name: "Walk-in",
    remarks: "FAILTEST",
    items: [{ product_id: prod, quantity: 1, unit_price: 100 }],
  }),
]);
await q("DROP TRIGGER zz_fail_post ON sales");
const failId = failing.rows?.[0]?.create_sale?.sale_id ?? failing.rows?.[0]?.create_sale?.id;
const failNote = await q(
  "SELECT body FROM notifications WHERE user_id=$1 AND title='Saved but not completed'",
  [chair],
);
ok(
  "chairman's sale is kept (pending) and notified when posting fails",
  !failing.error &&
    !!failId &&
    (await q("SELECT status FROM sales WHERE id=$1", [failId]))[0].status === "pending_approval" &&
    failNote.some((n) => n.body.includes("forced failure")),
  failing.error ?? JSON.stringify(failNote),
);

const adj = await as(chair, "SELECT request_stock_adjustment($1)", [
  JSON.stringify({
    entity_type: "finished_good",
    product_id: prod,
    factory_id: F,
    quantity_delta: -2,
    movement_type: "damaged",
    reason: "Burst packs",
  }),
]);
const adjRow = (
  await q("SELECT status FROM stock_adjustment_requests WHERE product_id=$1", [prod])
)[0];
ok(
  "chairman's stock write-off is posted",
  adjRow?.status === "posted",
  adj.error ?? adjRow?.status,
);

await q("UPDATE workflow_configs SET required_approvals = 2 WHERE module = 'expenses'");
// Fund the Expenses cash book so the cash-float check isn't what's tested.
await q(
  "INSERT INTO cash_transactions(factory_id, transaction_number, transaction_date, transaction_type, category, description, amount, payment_method, recorded_by_name) VALUES ($1,'RCT-TEST',CURRENT_DATE,'receipt','other_inflow','Float',100000000,'cash','Test')",
  [F],
);
const exp = await as(
  chair,
  "INSERT INTO expenses(factory_id, description, amount, expense_date, submitted_by, recorded_by) VALUES ($1,'Diesel',500,CURRENT_DATE,$2,$2) RETURNING id",
  [F, chair],
);
const expRow = exp.rows
  ? (await q("SELECT status FROM expenses WHERE id=$1", [exp.rows[0].id]))[0]
  : null;
const expNote = (
  await q("SELECT body FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [
    chair,
  ])
)[0];
ok(
  "chairman's expense is posted even when 2 approvals are required",
  expRow?.status === "posted",
  exp.error ?? `${expRow?.status} ${expNote?.body ?? ""}`,
);

console.log("\n[audit log]");
ok(
  "cannot forge audit row as another user",
  !!(await as(mgr, "INSERT INTO audit_logs(user_id, action) VALUES ($1,'fake')", [admin])).error,
);
const real = await as(mgr, "INSERT INTO audit_logs(user_id, action) VALUES ($1,'real')", [mgr]);
ok("CAN write own audit row", !real.error, real.error);
ok("cannot delete audit rows", denied(await as(admin, "DELETE FROM audit_logs")));

console.log("\n[app RPCs still callable by signed-in users]");
// Every supabase.rpc("...") name the app calls, scanned from src/.
const walk = (d) =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walk(new URL(e.name + "/", d))
        : /\.tsx?$/.test(e.name)
          ? [new URL(e.name, d)]
          : [],
    );
const names = [
  ...new Set(
    walk(
      process.argv[3]
        ? pathToFileURL(path.resolve(process.argv[3]) + "/")
        : new URL("../../../src/", import.meta.url),
    ).flatMap((f) =>
      [...fs.readFileSync(f, "utf8").matchAll(/\.rpc\(\s*"([a-z_0-9]+)"/g)].map((m) => m[1]),
    ),
  ),
].sort();
const missing = [];
for (const n of names) {
  const r = await q(
    "SELECT bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) v, count(*)::int c FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname='public' AND p.proname=$1",
    [n],
  );
  if (!r[0].c || !r[0].v) missing.push(`${n}${r[0].c ? "" : " (does not exist)"}`);
}
ok(
  `all ${names.length} RPCs the app calls are executable`,
  missing.length === 0,
  missing.join(", "),
);
for (const f of ["has_permission", "has_role", "has_production_scope_access", "is_active_user"])
  ok(
    `policy helper ${f} executable`,
    (
      await q(
        "SELECT bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')) v FROM pg_proc p WHERE proname=$1",
        [f],
      )
    )[0].v,
  );

console.log(`\n${pass} passed, ${fail} failed`);
await db.close();
process.exit(fail ? 1 : 0);
