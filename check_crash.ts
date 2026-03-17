import db from "./config/db";

async function testQuery() {
  const escrow_id = "some-id";
  const user_id = "test-uuid";
  try {
    const [rows]: any = await db.query(
        `SELECT 
           et.escrow_id, et.status, et.amount_held, et.payment_ref,
           et.buyer_confirmed, et.seller_confirmed, et.created_at,
           mo.airtime_amount, mo.seller_phone, mo.asking_price,
           isps.name AS network_name
         FROM escrow_transactions et
         JOIN marketplace_offers mo ON mo.offer_id = et.offer_id
         JOIN isps ON mo.network_id = isps.network_id
         WHERE et.escrow_id = ? AND (et.buyer_id = ? OR et.seller_id = ?)`,
        [escrow_id, user_id, user_id]
      );
      console.log(rows);
  } catch(e) {
      console.error("Crash:", e);
  } finally {
      process.exit();
  }
}

testQuery();
