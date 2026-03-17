import db from "./config/db";

async function checkTopups() {
  try {
    const [rows]: any = await db.query("SELECT * FROM yebo_coins ORDER BY transaction_timestamp DESC LIMIT 10");
    console.log("Recent yebo_coins rows:", JSON.stringify(rows, null, 2));

    const [uRows]: any = await db.query("SELECT email, yeboCoins FROM users WHERE yeboCoins > 0 LIMIT 5");
    console.log("Users with yeboCoins:", JSON.stringify(uRows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

checkTopups();
