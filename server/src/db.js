const path = require("path");
const fs = require("fs");
const { hashSecret } = require("./security");
const { sqliteDb, postgresDb, schemaForPg } = require("./database");

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");

// PostgreSQL (for example Supabase) when DATABASE_URL is set; otherwise a SQLite file in DATA_DIR.
const db = process.env.DATABASE_URL
  ? postgresDb(process.env.DATABASE_URL)
  : (fs.mkdirSync(path.join(DATA_DIR, "uploads"), { recursive: true }),
     sqliteDb({ file: path.join(DATA_DIR, "sarrif.db"), uploads: path.join(DATA_DIR, "uploads"), fs, path }));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  phone         TEXT    NOT NULL UNIQUE,
  role          TEXT    NOT NULL CHECK (role IN ('customer','agent','admin','super')),
  service       TEXT,
  pin_hash      TEXT    NOT NULL,
  pw_hash       TEXT,
  wallets       TEXT    NOT NULL DEFAULT '{}',
  suspended     INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id          TEXT    PRIMARY KEY,
  ref         TEXT    NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  cur         TEXT    NOT NULL CHECK (cur IN ('USD','SLSH')),
  from_wallet TEXT    NOT NULL,
  from_num    TEXT    NOT NULL,
  to_wallet   TEXT    NOT NULL,
  to_num      TEXT    NOT NULL,
  amount      REAL    NOT NULL,
  fee         REAL    NOT NULL,
  receive     REAL    NOT NULL,
  ussd        TEXT,
  status      TEXT    NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','sent')),
  acked       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER,
  sent_by     INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_customer ON requests(customer_id, created_at);
CREATE TABLE IF NOT EXISTS expenses (
  id         TEXT    PRIMARY KEY,
  date       TEXT    NOT NULL,
  cur        TEXT    NOT NULL CHECK (cur IN ('USD','SLSH')),
  amount     REAL    NOT NULL,
  category   TEXT    NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_requests_sent ON requests(status, sent_at);

-- Wallet ledger. A balance is the sum of a user's rows. user_id NULL is the platform (super admin income).
CREATE TABLE IF NOT EXISTS wallet_tx (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  cur        TEXT    NOT NULL CHECK (cur IN ('USD','SLSH')),
  amount     REAL    NOT NULL,
  kind       TEXT    NOT NULL,
  ref        TEXT,
  note       TEXT    NOT NULL DEFAULT '',
  by_user    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_tx(user_id, cur);
-- Affiliate earnings collect here (not in the wallet). The person withdraws them to the wallet when they reach the
-- amount they chose (users.withdraw_at). kind: affiliate (+) or withdraw (−).
CREATE TABLE IF NOT EXISTS earnings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  cur        TEXT    NOT NULL,
  amount     REAL    NOT NULL,
  kind       TEXT    NOT NULL,
  ref        TEXT,
  note       TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_earnings_user ON earnings(user_id, cur);

-- Wallet top-ups sent by USSD, waiting for the super admin to confirm the money arrived.
CREATE TABLE IF NOT EXISTS topups (
  id          TEXT    PRIMARY KEY,
  ref         TEXT    NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  cur         TEXT    NOT NULL CHECK (cur IN ('USD','SLSH')),
  amount      REAL    NOT NULL,
  ussd        TEXT,
  purpose     TEXT    NOT NULL DEFAULT 'topup',
  plan_id     TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note        TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  decided_by  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_topups_status ON topups(status, created_at);

-- Suuq marketplace
CREATE TABLE IF NOT EXISTS shops (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL UNIQUE REFERENCES users(id),
  name       TEXT    NOT NULL,
  sub_until  INTEGER NOT NULL DEFAULT 0,
  plan       TEXT,
  suspended  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id          TEXT    PRIMARY KEY,
  shop_id     INTEGER NOT NULL REFERENCES shops(id),
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  price       REAL    NOT NULL,
  cur         TEXT    NOT NULL CHECK (cur IN ('USD','SLSH')),
  mode        TEXT    NOT NULL CHECK (mode IN ('buy','book')),
  images      TEXT    NOT NULL DEFAULT '[]',
  video       TEXT    NOT NULL DEFAULT '',
  comm_type   TEXT    NOT NULL DEFAULT 'percent' CHECK (comm_type IN ('percent','flat')),
  comm_value  REAL    NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0,
  admin_hidden INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id);
CREATE TABLE IF NOT EXISTS orders (
  id           TEXT    PRIMARY KEY,
  ref          TEXT    NOT NULL,
  product_id   TEXT    NOT NULL REFERENCES products(id),
  shop_id      INTEGER NOT NULL REFERENCES shops(id),
  buyer_id     INTEGER NOT NULL REFERENCES users(id),
  seller_id    INTEGER NOT NULL REFERENCES users(id),
  kind         TEXT    NOT NULL CHECK (kind IN ('buy','book')),
  product_name TEXT    NOT NULL,
  qty          INTEGER NOT NULL,
  unit_price   REAL    NOT NULL,
  total        REAL    NOT NULL,
  cur          TEXT    NOT NULL,
  commission   REAL    NOT NULL DEFAULT 0,
  affiliate_id INTEGER REFERENCES users(id),
  status       TEXT    NOT NULL,
  note         TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
CREATE TABLE IF NOT EXISTS shop_expenses (
  id         TEXT    PRIMARY KEY,
  shop_id    INTEGER NOT NULL REFERENCES shops(id),
  date       TEXT    NOT NULL,
  cur        TEXT    NOT NULL,
  amount     REAL    NOT NULL,
  category   TEXT    NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
-- Private buyer-seller chat, one conversation per product per buyer.
CREATE TABLE IF NOT EXISTS conversations (
  id             TEXT    PRIMARY KEY,
  product_id     TEXT    NOT NULL REFERENCES products(id),
  buyer_id       INTEGER NOT NULL REFERENCES users(id),
  seller_id      INTEGER NOT NULL REFERENCES users(id),
  last_at        INTEGER NOT NULL,
  buyer_read_at  INTEGER NOT NULL DEFAULT 0,
  seller_read_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, buyer_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id    TEXT    NOT NULL REFERENCES conversations(id),
  sender_id  INTEGER NOT NULL REFERENCES users(id),
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, id);
-- Affiliate links: the first person whose link someone opened for a product. That person earns if they buy it,
-- and the link keeps that person's code when it is passed on ("first sender earns").
CREATE TABLE IF NOT EXISTS product_refs (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  product_id  TEXT    NOT NULL REFERENCES products(id),
  ref_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, product_id)
);
-- Tracking numbers a service (Saba Multi Services) gives its customers: where their order or shipment is now.
-- history is a JSON list of earlier updates: [{ at, status, location, note }].
CREATE TABLE IF NOT EXISTS trackings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  service    TEXT    NOT NULL,
  code       TEXT    NOT NULL,
  customer   TEXT    NOT NULL DEFAULT '',
  phone      TEXT    NOT NULL DEFAULT '',
  item       TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL,
  location   TEXT    NOT NULL DEFAULT '',
  note       TEXT    NOT NULL DEFAULT '',
  history    TEXT    NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (service, code)
);
CREATE TABLE IF NOT EXISTS service_docs (
  id         TEXT    PRIMARY KEY,
  service    TEXT    NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  note       TEXT    NOT NULL DEFAULT '',
  files      TEXT    NOT NULL DEFAULT '[]',
  status     TEXT    NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_tokens (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Creates the tables (first start) and upgrades older databases. Safe to run on every start.
async function init() {
  const pg = db.kind === "postgres";
  if (!pg) {
    // Upgrade a SQLite database made before super admins and per-service staff existed.
    const t = await db.tableSql("users");
    if (t && !t.includes("'super'")) {
      await db.exec(`PRAGMA foreign_keys = OFF; BEGIN;
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('customer','agent','admin','super')), service TEXT,
      pin_hash TEXT NOT NULL, pw_hash TEXT, wallets TEXT NOT NULL DEFAULT '{}', suspended INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, token_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO users_new (id, name, phone, role, service, pin_hash, pw_hash, wallets, suspended, failed, locked_until, token_version, created_at)
      SELECT id, name, phone, CASE role WHEN 'admin' THEN 'super' ELSE role END, CASE role WHEN 'agent' THEN 'ibedel' ELSE NULL END,
             pin_hash, pw_hash, wallets, suspended, failed, locked_until, token_version, created_at FROM users;
    DROP TABLE users; ALTER TABLE users_new RENAME TO users;
    COMMIT; PRAGMA foreign_keys = ON;`);
      console.log("Database upgraded: the old admin is now the super admin, and old agents belong to iBedel.");
    }
  }
  await db.exec(pg ? schemaForPg(SCHEMA) : SCHEMA);
  if (pg) await db.exec("CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, data BYTEA NOT NULL, created_at BIGINT NOT NULL)");

  // Columns added after the first release.
  const addColumn = async (table, name, def) => {
    if ((await db.columns(table)).includes(name)) return false;
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${pg ? schemaForPg(def) : def}`);
    return true;
  };
  await addColumn("users", "ref_code", "TEXT");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ref ON users(ref_code)");
  // Seller registration details (full name, birth date, country, city, type, address, phone, merchant numbers).
  await addColumn("shops", "profile", "TEXT NOT NULL DEFAULT '{}'");
  // Customer accounts vs merchant (seller) accounts. Anyone who already has a shop is a merchant.
  if (await addColumn("users", "account_type", "TEXT NOT NULL DEFAULT 'customer'"))
    await db.run("UPDATE users SET account_type = 'merchant' WHERE id IN (SELECT owner_id FROM shops)");
  for (const u of await db.all("SELECT id FROM users WHERE ref_code IS NULL")) await db.run("UPDATE users SET ref_code = ? WHERE id = ?", await newRefCode(), u.id);
  // Visa listings and hidden prices.
  await addColumn("products", "service", "TEXT NOT NULL DEFAULT 'suuq'");
  await addColumn("products", "price_hidden", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("products", "price_label", "TEXT NOT NULL DEFAULT ''");
  await addColumn("requests", "proof", "TEXT");
  await addColumn("requests", "to_name", "TEXT NOT NULL DEFAULT ''"); // sending to another person: their name
  // Product approval: new and edited products wait for the Suuq (or Visa) admin. Products that existed before stay approved.
  await addColumn("products", "approval", "TEXT NOT NULL DEFAULT 'approved'");
  await addColumn("products", "review_note", "TEXT NOT NULL DEFAULT ''");
  await addColumn("products", "country", "TEXT NOT NULL DEFAULT ''"); // the country a visa is for
  // How a buy order is paid: wallet, safe (to the money processor, held until the buyer confirms) or shop (straight to the merchant).
  await addColumn("orders", "pay_method", "TEXT NOT NULL DEFAULT 'wallet'");
  await addColumn("orders", "pay_fee", "REAL NOT NULL DEFAULT 0");
  await addColumn("orders", "pay_ussd", "TEXT NOT NULL DEFAULT ''");
  // Requests the merchant accepts and then prices: the item name and description they offer, and where a declined
  // request was passed on to (another merchant selling the same thing).
  await addColumn("users", "withdraw_at", "TEXT NOT NULL DEFAULT '{}'"); // the earnings amount (per currency) the person withdraws at
  await addColumn("orders", "offer_desc", "TEXT NOT NULL DEFAULT ''");
  // Service listings (hotel rooms, technicians, cars…): a category, how many are free (-1 = no limit) and the price unit.
  await addColumn("products", "category", "TEXT NOT NULL DEFAULT ''");
  await addColumn("products", "stock", "INTEGER NOT NULL DEFAULT -1");
  await addColumn("products", "unit", "TEXT NOT NULL DEFAULT ''");
  await addColumn("orders", "reserved", "INTEGER NOT NULL DEFAULT 0"); // a room (or other limited item) is held for this order
  await addColumn("orders", "from_order", "TEXT NOT NULL DEFAULT ''");
  await addColumn("orders", "forwarded_to", "TEXT NOT NULL DEFAULT ''");
  // Every shop has a shop number people can search for: 1001, 1002 … (more digits once 9999 is used).
  await addColumn("shops", "shop_no", "INTEGER");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_no ON shops(shop_no)");
  for (const s of await db.all("SELECT id FROM shops WHERE shop_no IS NULL ORDER BY id")) await db.run("UPDATE shops SET shop_no = ? WHERE id = ?", await nextShopNo(), s.id);

  if (pg) {
    // Supabase also publishes every table through its web API (with the public "anon" key). Turning on row-level
    // security with no rules closes that door: only this server (which logs in as the database owner) can read the data.
    const tables = (await db.all("SELECT tablename AS t FROM pg_tables WHERE schemaname = current_schema()")).map(r => r.t);
    for (const t of tables) await db.exec(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
  }
}

// The next free shop number: 1001, 1002, … 9999, then 10000 and up.
async function nextShopNo() {
  const r = await db.get("SELECT MAX(shop_no) AS n FROM shops");
  return Math.max(Number(r?.n) || 0, 1000) + 1;
}

// Every person gets a short affiliate code, e.g. K7Q2M9.
async function newRefCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    let c = ""; for (let i = 0; i < 6; i++) c += A[require("node:crypto").randomInt(A.length)];
    if (!await db.get("SELECT 1 FROM users WHERE ref_code = ?", c)) return c;
  }
}

const WALLETS = ["zaad", "edahab", "soltelco", "premier"];
// Wallets where the customer uploads a screenshot of their payment instead of dialing USSD.
const PROOF_WALLETS = ["premier"];
const CURS = ["USD", "SLSH"];

// Services on the customer home page. "ready" means the service has been built; others show "Coming soon".
const ARTS = ["money", "electronics", "travel", "visa", "education", "technician", "hotel", "carrent", "schoolbus", "restaurant", "food", "health", "shop", "car", "home", "general"];
const DEFAULT_SERVICES = [
  { id: "ibedel", name: "iBedel", sub: "Send money between your wallets", art: "money", visible: true, ready: true, builtIn: true },
  { id: "suuq", name: "Suuq", sub: "Phones, laptops and more", art: "electronics", visible: true, ready: true, builtIn: true },
  { id: "ticket", name: "Ticket", sub: "Flight tickets", art: "travel", visible: true, ready: false, builtIn: true },
  { id: "visa", name: "Visa", sub: "Travel visas", art: "visa", visible: true, ready: true, builtIn: true },
  { id: "scholarship", name: "Scholarship", sub: "Study opportunities", art: "education", visible: true, ready: false, builtIn: true },
  { id: "technician", name: "Technician", sub: "Repairs and installation", art: "technician", visible: true, ready: false, builtIn: true },
  { id: "hotels", name: "Hotels", sub: "Rooms and stays", art: "hotel", visible: true, ready: false, builtIn: true },
  { id: "car-rent", name: "Car rent", sub: "Rent a car by the day", art: "carrent", visible: true, ready: false, builtIn: true },
  { id: "school-bus", name: "School Bus", sub: "Safe rides to school", art: "schoolbus", visible: true, ready: false, builtIn: true },
  { id: "restaurant", name: "Restaurant", sub: "Menu, dinners and sweets", art: "restaurant", visible: true, ready: false, builtIn: true },
];

const DEFAULT_SETTINGS = {
  services: DEFAULT_SERVICES,
  // Suuq seller subscription plans (set by the Suuq admin). Paid from the seller's wallet; the money is platform income.
  // Where customers send money to top up their wallet: *880*<number>*<amount># (codes per currency, set by the super admin).
  // The charge (percent) when people send their affiliate earnings out with iBedel. Set by the iBedel admin.
  earnFeePct: 0,
  walletTopup: { number: "", numbers: { USD: "", SLSH: "" }, ussd: { USD: "*880*", SLSH: "*220*" } },
  // Safe payment: the buyer pays the money processor agent; Sarrif holds it until the buyer confirms they received the item.
  // merchant = the processor's merchant number (*223* SLSH, *883* USD); number = its normal number (*220* SLSH, *880* USD).
  // The same codes are used for "Pay to shop" with the merchant's own numbers.
  safePay: { merchant: "", number: "", codes: { SLSH: { merchant: "*223*", normal: "*220*" }, USD: { merchant: "*883*", normal: "*880*" } } },
  // Merchant plans. "free" is given once, automatically, when a merchant registers. maxProducts 0 = unlimited.
  // Words a seller can show instead of a hidden price (Visa and Suuq listings). The Visa admin can change the list.
  priceWords: ["Contact for price", "Price on request", "Ask in chat", "Negotiable", "Qiimaha la xiriir"],
  suuq: { plans: [
    { id: "free", name: "Free", days: 30, price: 0, cur: "USD", maxProducts: 5 },
    { id: "basic", name: "Basic", days: 30, price: 5, cur: "USD", maxProducts: 20 },
    { id: "business", name: "Business", days: 30, price: 15, cur: "USD", maxProducts: 100 },
    { id: "business-plus", name: "Business+", days: 30, price: 30, cur: "USD", maxProducts: 0 },
  ] },
  tiers: {
    USD: [{ upTo: 35, fee: 0.35 }, { upTo: null, fee: 1 }],
    SLSH: [{ upTo: 350000, fee: 3500 }, { upTo: null, fee: 10000 }],
  },
  show: Object.fromEntries(WALLETS.map(w => [w, { on: true, USD: true, SLSH: true }])),
  agentNums: Object.fromEntries(WALLETS.map(w => [w, ""])),
  ussd: Object.fromEntries(WALLETS.map(w => [w, { SLSH: "*220*", USD: "*880*" }])),
  support: { whatsapp: "" },
  voice: {
    script: "Welcome to Sarrif. Log in with your phone number and four-digit PIN, or create a new account. Choose dollars or shillings, pick the wallet you send from and enter the amount. Then pick the company you want to receive in. Your request goes to our agent, and you can see when it is sent.",
    lang: "en-US",
    audio: null,
  },
};

async function getSettings() {
  const row = await db.get("SELECT value FROM settings WHERE key = 'app'");
  const saved = row ? JSON.parse(row.value) : {};
  const s = structuredClone(DEFAULT_SETTINGS);
  if (saved.tiers) for (const c of CURS) if (Array.isArray(saved.tiers[c]) && saved.tiers[c].length) s.tiers[c] = saved.tiers[c];
  for (const w of WALLETS) {
    if (saved.show?.[w]) s.show[w] = { ...s.show[w], ...saved.show[w] };
    if (saved.ussd?.[w]) s.ussd[w] = { ...s.ussd[w], ...saved.ussd[w] };
    if (saved.agentNums?.[w] != null) s.agentNums[w] = saved.agentNums[w];
  }
  if (saved.support) s.support = { ...s.support, ...saved.support };
  if (saved.voice) s.voice = { ...s.voice, ...saved.voice };
  if (Array.isArray(saved.services) && saved.services.length) s.services = saved.services;
  // Upgrades: Suuq is built now; "Ticket & Visa" became two services.
  s.services = s.services.map(x => x.id === "suuq" ? { ...x, ready: true } : x);
  if (!s.services.some(x => x.id === "visa")) {
    const i = s.services.findIndex(x => x.id === "ticket");
    if (i >= 0 && s.services[i].name === "Ticket & Visa") s.services[i] = { ...s.services[i], name: "Ticket", sub: "Flight tickets" };
    s.services.splice(i >= 0 ? i + 1 : s.services.length, 0, DEFAULT_SERVICES.find(x => x.id === "visa"));
  }
  // New built-in services are added once to older installs (a service the admin later removes stays removed).
  const added = new Set(Array.isArray(saved.addedServices) ? saved.addedServices : []);
  for (const id of ["technician", "hotels", "car-rent", "school-bus", "restaurant"]) {
    if (!added.has(id) && !s.services.some(x => x.id === id)) s.services.push(structuredClone(DEFAULT_SERVICES.find(x => x.id === id)));
    added.add(id);
  }
  s.addedServices = [...added];
  if (saved.suuq) s.suuq = { ...s.suuq, ...saved.suuq };
  if (Array.isArray(saved.priceWords) && saved.priceWords.length) s.priceWords = saved.priceWords;
  // Visa is built now: sellers list visas like products.
  s.services = s.services.map(x => x.id === "visa" ? { ...x, ready: true } : x);
  // Older installs had "1 month / 12 months" plans with no tiers: switch to the tiered plans.
  if (!s.suuq.plans.some(p => p.id === "free")) s.suuq.plans = structuredClone(DEFAULT_SETTINGS.suuq.plans);
  if (Number(saved.earnFeePct) >= 0) s.earnFeePct = Number(saved.earnFeePct);
  s.ticketAdminAgency = Number(saved.ticketAdminAgency) || 0; // the Ticket admin's agency: it gets half of all ticket requests
  if (saved.safePay) s.safePay = { ...s.safePay, ...saved.safePay, codes: { SLSH: { ...s.safePay.codes.SLSH, ...(saved.safePay.codes?.SLSH || {}) }, USD: { ...s.safePay.codes.USD, ...(saved.safePay.codes?.USD || {}) } } };
  if (saved.walletTopup) s.walletTopup = { ...s.walletTopup, ...saved.walletTopup, ussd: { ...s.walletTopup.ussd, ...(saved.walletTopup.ussd || {}) }, numbers: { ...s.walletTopup.numbers, ...(saved.walletTopup.numbers || {}) } };
  return s;
}
async function saveSettings(patch) {
  const next = { ...await getSettings(), ...patch };
  await db.run("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
  return next;
}

async function seedAdmin() {
  const count = (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'super'")).n;
  if (count > 0) return;
  const { ADMIN_NAME, ADMIN_PHONE, ADMIN_PIN, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_PHONE || !ADMIN_PIN || !ADMIN_PASSWORD) {
    console.warn("No super admin exists yet. Set ADMIN_PHONE, ADMIN_PIN and ADMIN_PASSWORD in .env and restart.");
    return;
  }
  if (!/^\d{4}$/.test(ADMIN_PIN)) throw new Error("ADMIN_PIN must be 4 digits.");
  if (ADMIN_PASSWORD.length < 8) throw new Error("ADMIN_PASSWORD must be at least 8 characters.");
  await db.run(`INSERT INTO users (name, phone, role, pin_hash, pw_hash, created_at, ref_code) VALUES (?, ?, 'super', ?, ?, ?, ?)`,
    ADMIN_NAME || "Admin", cleanPhone(ADMIN_PHONE), hashSecret(ADMIN_PIN), hashSecret(ADMIN_PASSWORD), Date.now(), await newRefCode());
  console.log(`Super admin account created for ${cleanPhone(ADMIN_PHONE)}.`);
}

function cleanPhone(p) { return String(p || "").replace(/\D/g, "").replace(/^252/, "").replace(/^0/, ""); }
function cleanNum(p) { return String(p || "").replace(/\D/g, ""); }

module.exports = { init, nextShopNo, newRefCode, PROOF_WALLETS, ARTS, db, DATA_DIR, WALLETS, CURS, getSettings, saveSettings, seedAdmin, cleanPhone, cleanNum };
