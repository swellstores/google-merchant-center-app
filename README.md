# Google Merchant Center for Swell

**List your products in Google Shopping and free listings, and keep them current.**

The app connects a Swell store to one Google Merchant Center account. Every active product and variant is sent to Google as an offer, and later changes to its name, price, images or stock follow within minutes. Google's verdict on each product, and the reasons it holds products back, come back to Swell, so you can see and fix problems without leaving the dashboard.

---

## Features

### Connection to Google Merchant Center

Connects the store to one Merchant Center account through the merchant's own Google Cloud service account. Pick the country you sell to when you connect; its language and currency are set from it. The **Product link** is the address shoppers land on from Google, built from the product's slug or ID (a variant link can use the variant ID). **Check again** runs Google's checks (key, access token, API registration, account access, website) and shows what is wrong, next to the setup step it belongs to. **Disconnect** stops sending and forgets the key, and can also remove the products this store sent to Google. If Google stops accepting the connection, the store admins get one email.

- **Where you see it:** **Apps → Google Merchant Center → Settings** (Connection section), and the email "Google Merchant Center is disconnected".
- **Built with:** the `GoogleConnect` component and the `connection` route function; the key and the cached access token in the app collection `connections` (private fields); the country in `markets`; the `connection-broken` notification.

### Catalog sync

Active products and their active variants are sent to Google in batches: one offer per variant, or one per product when it has no variants. A product is left out when it is inactive, hidden from Google, a gift card or subscription-only. Variants are judged one by one: a variant without a price or an image is skipped on its own, and a product is left out only when none of its variants qualify. Changes to a product, a variant or the stock are queued and sent within minutes. **Sync all** sends the whole catalog again, with progress. The app respects Google's daily limit, pauses when it is reached and resumes by itself.

- **Where you see it:** **Apps → Google Merchant Center → Settings** (Overview section: progress, queue, **Sync all**).
- **Built with:** `enqueue` (`product.created`, `.updated`, `.deleted`, the same for variants, and `product.stock_adjusted`), `courier` (runs at an alarm time, sends in batches), `hourly` (cron, every hour: starts due status checks and keeps the courier going), the app collections `queue-items`, `sync-states`, `alarms` and `markets`; the `sync` route function.

### Statuses

Google reviews each offer. The app reads the result back and counts products as **Approved**, **Partly approved**, **Pending**, **Disapproved**, **Not sent** or **Hidden**. **Top issues** lists what Google reports most often, with a severity, the number of products and a few examples, and a link to Google's help. Statuses are checked roughly every hour; **Refresh statuses** checks them now. A product page shows the same status for that product.

- **Where you see it:** **Apps → Google Merchant Center → Settings** (Overview section: counters, **Top issues**, **Refresh statuses**), a **Google** column in the product list, and the status panel on the product's **Google** tab.
- **Built with:** the `SyncDashboard` and `GoogleStatus` components, the `sync` and `product` route functions, the product fields `status_label` and `date_status`.

### Account reasons

Sometimes Google holds every product because of the account, not the products: the website is not verified, shipping is not set up, a policy needs attention. The app reads these reasons from Merchant Center and shows them with what to do and a link to the fix. They explain why products wait in **Pending**.

- **Where you see it:** the "Google is not showing your products yet" card in **Apps → Google Merchant Center → Settings** (Overview section), and a line on pending products' **Google** tab.
- **Built with:** the `SyncDashboard` and `GoogleStatus` components; the `sync` and `product` route functions.

### The Google tab on products

Every product has a **Google** tab. All of it is optional; the app sends what it can without it.

- **Hide from Google:** keeps the product out of Google. Products already in Google are removed within minutes.
- **Brand:** the product's brand. Google requires it for most products.
- **Condition:** new (the default), used or refurbished.
- **Google product category:** optional. Google picks one itself; set it only to correct Google, by pasting a category number or full path from the Google product taxonomy.
- **Age group** and **Gender:** for clothing and accessories, where Google requires them.
- **No barcode (GTIN) or part number (MPN):** for handmade, custom or vintage products. It hides the MPN field and the barcodes table.
- **MPN:** the manufacturer part number. Variants without their own use this one.
- **Barcodes:** a table with a GTIN (UPC, EAN, ISBN) and, if needed, an MPN for each variant. A variant's MPN overrides the product's.
- **Variant attributes:** for products with variants, shows Color, Size, Material and Pattern. Pick the variant option that holds each one, and every variant sends its own value. When Google asks for one, the row says so. Every variant also sends all its options to Google as variant options, as named in Swell.
- **Status** and **Preview:** what Google says about the product right now, and how the product can look in Google Shopping, built from the unsaved form. The status panel also has **Resend now**, which queues the product for Google again. It shows only while the store is connected and the product is not hidden.

- **Where you see it:** the **Google** tab on the product page.
- **Built with:** the content view `content/products.json`, with native fields for hiding, brand, condition, category, MPN, age group and gender; the components `GtinTable`, `GoogleNeeds`, `GoogleStatus` and `ShoppingPreview`; the `product` route function; the product fields under `$app.google_merchant_center`.

---

## Setup

### What you need

- A Google account that can create a Google Cloud project, and a Merchant Center account.
- Your website verified and claimed in Merchant Center, and shipping set up there.
- Your Merchant Center account ID.

### Steps

The app talks to Merchant Center through a service account: a robot Google account that you create in your own Google Cloud project. Its key stays in your store.

Open **Apps → Google Merchant Center → Settings** (Connection section) in your Swell dashboard. It shows the same four steps with links.

1. **Google Cloud project.** Create a project and enable the **Merchant API** in it.
2. **Service account key.** In the project, create a service account and add a JSON key under **Keys**. Drop the JSON file on the page, or paste its text.
3. **Merchant Center access.** In Merchant Center, verify and claim your website (**Settings → Business info → Website**). The Connection section shows the service account's email, with a **Copy** button. Add it in **Settings → People and access** with **Admin** access. Set up shipping in **Products & store → Shipping and returns**; without it Google disapproves every product.
4. **Connect.** Enter your **Merchant Center account ID**, choose the **Country you sell to**, check the **Product link**, and press **Connect**. The app checks everything with Google, and each step turns green or shows what to fix. When all checks pass, the catalog starts to sync.

### Settings

| Field | What it does |
|---|---|
| Merchant Center account ID | The account the products are sent to. |
| Country you sell to | The market: country, language and currency. Changing it later removes the products from Google and sends them again for the new country. |
| Product link | Where shoppers land from Google. Use `{slug}` or `{product_id}`; `{variant_id}` opens the variant. |

---

## Day-to-day use

- **Nothing to do for new products and changes.** They are queued and sent on their own.
- **Fill in the Google tab** for products Google disapproves: most often a brand, barcodes, or the **Variant attributes**.
- **Hide what you do not want listed** with **Hide from Google**.
- **Look in now and then** at **Apps → Google Merchant Center → Settings** (Overview section). The account card says what Merchant Center needs from you; **Top issues** says what Google found in the products.
- **Sync all** after changes made outside Swell or when Google lost products. **Refresh statuses** to see Google's latest verdict.

---

## Limits and known issues

**Not supported yet**

- More than one market (country) per store.
- Bulk actions on the product list. Hide and edit products one by one.
- Searching Google's categories, or suggesting brands.
- Subscription-only products and gift cards (they are not sent).

**Rate limits**

- Google has a daily limit on calls. When it is reached, **Apps → Google Merchant Center → Settings** (Overview section) says when syncing resumes.
- Statuses are checked roughly every hour, so a fix can take that long to show.

**Environments**

- Each Swell environment (test and live) has its own connection and settings.

---

## Development

**Requirements:** the Swell CLI, logged in to your store.

```bash
npm install
npm test                 # Vitest in the Workers runtime
swell app push           # deploy to the store
```


**Where things are:** `functions/` (route functions, event and cron entry points, shared code in `functions/lib/`), `components/` (the Connection and Overview sections of the app's Settings, and the product tab components), `models/` (app collections), `content/` (the product view), `settings/`, `notifications/`, `test/unit/`, `assets/` (icon and screenshots).
