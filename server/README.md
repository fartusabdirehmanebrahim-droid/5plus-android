# Sarrif

Sarrif is a wallet-to-wallet transfer app for ZAAD, eDahab, Soltelco and Premier Wallet. Money moves in one currency only: SLSH to SLSH, or USD to USD.

Customers log in and choose a service from the home page: **iBedel** (money transfer), **Suuq**, **Ticket & Visa**, **Scholarship**, and any service the super admin adds. Services that are not built yet show "Coming soon".

Everyone uses the same login screen and only sees their own part:

| Who | Logs in with | Sees |
|---|---|---|
| Customer | Phone number + 4-digit PIN | Services home page; iBedel Send, History, Account (with the WhatsApp support button) |
| Agent of a service | Phone number + PIN (created by that service's admin) | Only that service's work (for iBedel: transfer requests, alert sound, "Mark as sent") |
| Admin of a service | Phone number + PIN + password (created by the super admin) | Only that service's dashboard and its agents |
| Super admin | Phone number + PIN + password (from `.env`) | Every service: overview, show/hide or add services, create service admins, open any service's dashboard |

## Suuq marketplace, wallet and affiliates

- **Wallet** (every service except iBedel): created for every customer and merchant when they register, with a USD and an SLSH balance and a full history.
- **Top up by USSD:** in Wallet the person picks USD or SLSH, types the amount and presses **Send**; the phone dials `*880*<top-up number>*<amount>#` (SLSH uses `*220*` by default). The request appears in Super admin → Wallets → Top-up requests; after checking the money arrived, the super admin approves it and the wallet is credited. The super admin sets the top-up number and codes on the same tab. Withdrawals are done by the super admin (find by phone).
- **Merchant plans:** Free (given automatically for 1 month when a merchant registers, up to 5 products), Basic ($5, 20 products), Business ($15, 100 products), Business+ ($30, unlimited), each 30 days. The Suuq admin can change names, days, prices and product limits. Merchants pay from their wallet or directly by USSD (`*880*<number>*<plan price>#`); when the super admin approves that payment, the shop is renewed or upgraded at once.
- **Two account types:** the first screen has *Create customer account* and *Register as merchant*. Merchants (sellers) register with the seller form and a PIN, and log in with the phone number from that form. Customers can later become merchants from Account → Become a merchant. Only merchants see *My shop* in Suuq and the *My shop dashboard* card on the home page.
- **Suuq sellers** first fill in the seller registration form (full name, birth date (18+), country from a list that includes Somaliland, city, shop or company, its name, address, phone, ZAAD and/or eDahab merchant number, and an optional normal shop number), then open the shop by paying a subscription plan from their wallet. They can edit the details later under Sell → Subscription, and the Suuq admin sees them under Sellers. That money goes to the super admin as income. The Suuq admin sets the plans.
- Subscribed sellers post products with a short name, price (USD or SLSH), up to 10 real photos (at least one; the server checks each file really is a JPG, PNG or WebP photo; the seller picks the main photo, and customers switch between photos with thumbnails), a video link (YouTube, TikTok, Facebook, Instagram, Vimeo, Dailymotion or a direct video file) and a description. They choose **Buy** or **Book**.
- **Search and shop numbers:** the services page has one search box (the greeting "Salaan, Hi …" is in the side menu). People search by shop number, shop or company name, merchant name, product name or service name. Every shop gets a shop number when it is created: 1001, 1002 … and more digits once 9999 is used. The merchant sees it in My shop; tapping a shop in the results (or "Sold by" on a product) opens the shop's page with all its products.
- **Service pictures:** the built-in services use real photos from `public/photos/services/` (see the README there). The super admin can put their own photo on any tile: Services tab → **Use my photo** (or **Change photo** / **Remove photo**). Customers see it at once; removing it brings back the standard photo.
- **Product approval:** every new product or visa, and every edited one, waits for the admin before customers can see it. The Suuq admin approves Suuq products, the Visa admin approves visas (the super admin can do both) under Products / Visas, where the ones waiting are shown first and counted on the tab. The admin taps **Approve**, or writes a reason and taps **Reject**; the merchant sees the result at once in My shop → Products, with the reason, and can edit and save to send it again. Products that existed before this feature stay approved.
- **Buy:** the buyer pays from their wallet with their PIN. The money is held until the buyer taps "I received it", then it goes to the seller. A paid order can be cancelled with a full refund.
- **Book:** the buyer sends a booking request; the seller accepts or declines, then marks it done. No money moves in the app.
- **Chat:** every product has a private chat between the buyer and the seller. Nobody else can read it.
- **Seller dashboard:** Report (sales, expenses, profit per day, week or month), Products, Orders (pending and past), Subscription.
- **Affiliate program:** open to everyone, customers and sellers, including buyers. A seller earns from sharing other sellers' products; a seller's link to their own product has no code, so they keep the whole price. Each person has a code; product links look like `/?p=<product>&ref=<code>`. The seller sets the earning per product as a percentage or a flat amount. When an order bought through the link is completed, the earning is paid from the sale into the sharer's wallet. **The first sender earns:** when someone opens a product from a shared link, that sender is remembered for them and that product. If they pass the link on, it keeps the first sender's code, and the first sender earns from their purchase too. A seller's own link has no code, so the seller keeps the whole price.
- **Visa:** merchants list visas from the same shop (My shop → Products → **Add visa**), each for one **country**, with a price, pictures, a video link, a description and an affiliate earning. Any seller can **hide the price**: customers then see words the seller picks from a list (for example "Contact for price") and tap **Ask for price**. The seller sends the total price from Orders, the customer pays it from the wallet, and the order continues like a normal purchase. The affiliate earning is always shown, hidden price or not (as the seller's percentage, or the flat amount). The Visa admin can hide any visa and edit the list of words. Hiding the price works the same way for Suuq products. Customers browse visas by country (the country buttons at the top of Visa, with flags) or search for a country.
- **Suuq admin:** sellers (suspend or reopen shops), products (hide any product), subscription plans, and Suuq agents.

## What it does

- **Customers** register once with their name, phone number, PIN and their wallet numbers. After "Send request", the app shows the USSD code for the agent's number (for example `*220*634000000*100000#`) with a Call button. The request then goes to the agents.
- **Agents** see each request with the customer's receiving number. A new request makes an alert ring until the agent taps "Stop sound". "Mark as sent" changes the request to Sent on the customer's phone straight away.
- **The admin** can:
  - add agents, reset agent and customer PINs, and suspend or reactivate anyone
  - search the list of registered customers
  - set the flat service charges
  - show or hide any wallet or currency
  - set agent numbers and USSD codes
  - set the WhatsApp support number and the voice guide
  - see **Finance**: revenue (service charges on sent transfers), expenses and net profit per day, per week (weeks start on Saturday) or per month, in SLSH or USD. Filter by Today, This week, This month or any custom dates, and add or delete expenses

## Security built in

- PINs and passwords are stored only as scrypt hashes (a slow, salted hash), never as plain text.
- Five wrong PINs or passwords lock the account for 15 minutes. There is also a limit on login attempts from the same internet address.
- The login cookie is signed, cannot be read by page scripts (`HttpOnly`), and is not sent from other sites (`SameSite=Strict`). It lasts 12 hours.
- Resetting a PIN or suspending someone logs them out on every device immediately.
- The server works out every charge and USSD code itself. It never trusts amounts or charges sent from the phone.
- Customers never receive agent numbers, other customers' data or the admin settings.
- Strict security headers are set (a Content Security Policy, no framing).

## Running it

You need **Node.js 22.5 or newer**. The app uses only built-in Node.js features, so there is nothing to `npm install`.

```bash
cp .env.example .env      # then edit .env: set JWT_SECRET and the ADMIN_ values
npm start                 # opens on http://localhost:3000
```

The first time the server starts, it creates the **super admin** from the `ADMIN_` values in `.env`. A database from an earlier version is upgraded automatically: the old admin becomes the super admin and existing agents belong to iBedel. After that, you can delete `ADMIN_PIN` and `ADMIN_PASSWORD` from the file. Log in as the admin and open **Settings** to:

1. Enter the agent receiving numbers and check the USSD codes (`*220*` for SLSH, `*880*` for USD).
2. Enter the WhatsApp support number.
3. Check the service charges.

Then go to **Agents** and add your agents.

## Database: Supabase (PostgreSQL) or SQLite

The app works with either database. Nothing to install in both cases.

- **Supabase / PostgreSQL** (for going live): set `DATABASE_URL` in `.env`. The first start creates every table by itself. Uploaded pictures and the voice recording are stored in the database too (table `files`), so the server keeps no files of its own and can be moved or restarted freely.
- **SQLite** (for testing on your computer): leave `DATABASE_URL` empty. Everything is kept in `data/`.

### Connecting Supabase

The tables already exist in the Supabase project `aobotiizixclknvsxmfv` (created on 28 September 2026; `supabase-schema.sql` holds the same schema). The server only needs the connection string:

1. Open your project on supabase.com and press **Connect** (top of the page).
2. Choose **Session pooler** and copy the URI. It looks like
   `postgresql://postgres.YOUR-PROJECT-REF:[YOUR-PASSWORD]@aws-0-REGION.pooler.supabase.com:5432/postgres`.
   (Use the Session pooler, not "Direct connection": the direct address only works on IPv6 networks, which most hosts don't have.)
3. Replace `[YOUR-PASSWORD]` with your **database password** (the one chosen when the project was created; if you don't have it, Project Settings → Database → Reset database password). If the password has characters like `@ : / # ?`, pick a new one with only letters and numbers.
4. Put it in `.env` as `DATABASE_URL=…` (or in your host's environment settings) and start the server. The log says `database: PostgreSQL`.

Notes:
- The app talks to the database directly with this connection string. It doesn't use the Supabase API keys (publishable/secret); keep those out of the app and out of `.env`.
- Row-level security is switched on for every table, so the tables can't be read through Supabase's public web API; only this server can use them.
- The connection is encrypted (TLS). To also check Supabase's certificate, download it (Project Settings → Database → SSL certificate), set `DATABASE_CA_CERT=/path/to/prod-ca-2021.crt` and add `?sslmode=verify-full` to the end of `DATABASE_URL`.
- Money changes (wallet payments, top-ups, orders) run one at a time in the database, so two payments can never both spend the same balance.
- Back up: Supabase makes daily backups on paid plans; on the free plan use Database → Backups or `pg_dump`.

## Putting it online

Any host that runs Node.js 22 works: a small VPS, Render, Railway, Fly.io, and others.

- Put it behind **HTTPS** and set `COOKIE_SECURE=true`.
- With **Supabase** (`DATABASE_URL` set), the server keeps nothing on its own disk, so any Node.js host works, including free ones. With SQLite instead, keep the `data/` folder on a **persistent disk** and back it up daily.
- Set a long random `JWT_SECRET`. You can make one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

Customers open the website on their phone. They can add it to the home screen, and it opens like an app.

## About USSD dialing

A website can open the phone dialer with the code already filled in, but the customer still has to press call. Browsers never let a website start a call by itself. The **5PLUS Android app** in `android/` can: it shows this website and places the USSD call straight away (it asks for the phone-call permission once). See `android/README.md` for how to get the APK.

## Files

```
src/server.js     web server and every API route
public/finance.js the admin Finance view (revenue, expenses, profit)
public/art.js     the pictures on the service tiles
public/suuq.js    Suuq, wallet and affiliate screens, Suuq admin, super admin wallets
src/market.js     wallet, Suuq, chat and affiliate API
src/db.js        database tables, upgrades and settings
src/database.js  one database interface for PostgreSQL (Supabase) and SQLite
src/pg.js        a small PostgreSQL client (TLS, SCRAM login, pool) with no packages to install
src/security.js  password hashing, session tokens, cookies
public/          the app screens (index.html, app.js, styles.css, logos)
demo/            the demo page builder (see Demo page)
android/         the Android app (calls USSD codes directly); see android/README.md
data/            created automatically: sarrif.db and uploaded voice files
```


## Push notifications (order alarms when the app is closed)

New requests, bookings and first chats ring merchants' and admins' phones for 25 seconds (paid orders for 10 seconds), even when 5PLUS is closed or the phone is locked. Customers get a normal notification when a price is sent, an order is accepted or delivered, or a message arrives.

1. Create a free Firebase project at console.firebase.google.com.
2. Add an Android app with the package name `com.fiveplus.app`, download `google-services.json` and put it in `android/app/` (next to `build.gradle.kts`), then build the APK again. Without this file the app works, with no push.
3. In Firebase: Project settings → Service accounts → Generate new private key. Paste the whole file in Super admin → Services → Push notifications (or put it in the server's `FCM_SERVICE_ACCOUNT` setting). Keep this file secret; never upload it to GitHub.
4. Log in on your phone in the app, then press "Send a test alarm to my phone".
