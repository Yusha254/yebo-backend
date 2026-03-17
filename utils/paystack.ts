import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Dynamically parse .env to bypass stale parent cache during nodemon wrapper
const envPath = path.resolve(process.cwd(), ".env");
const envVars = dotenv.parse(fs.readFileSync(envPath));

const PAYSTACK_URL = "https://api.paystack.co";
const SECRET_KEY = envVars.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY;

const paystack = axios.create({
  baseURL: PAYSTACK_URL,
  headers: {
    Authorization: `Bearer ${SECRET_KEY}`,
    "Content-Type": "application/json",
  },
});

/**
 * Initialize a transaction for the buyer
 */
export const initializeTransaction = async (email: string, amount: number, metadata: any) => {
  try {
    console.log(`[PAYSTACK API] Initializing transaction for ${email}, amount: ${amount} ZAR...`);
    const payload = {
      email,
      amount: amount * 100, // Paystack works in kobo/cents
      currency: "ZAR",
      metadata,
    };
    console.log(`[PAYSTACK API] Request Payload:`, JSON.stringify(payload, null, 2));

    const response = await paystack.post("/transaction/initialize", payload);
    console.log(`[PAYSTACK API] Success! Response snippet:`, JSON.stringify(response.data).substring(0, 150));
    return response.data;
  } catch (error: any) {
    if (error.response) {
       console.error("[PAYSTACK API ERROR] Paystack sent a failure response:");
       console.error(" - Status:", error.response.status);
       console.error(" - Data:", JSON.stringify(error.response.data, null, 2));
    } else {
       console.error("[PAYSTACK API ERROR] Network/Other error:", error.message);
    }
    throw new Error(error.response?.data?.message || "Failed to initialize Paystack transaction");
  }
};

/**
 * Create a Transfer Recipient (Seller)
 */
export const createTransferRecipient = async (name: string, accountNumber: string, bankCode: string) => {
  try {
    const response = await paystack.post("/transferrecipient", {
      type: "nuban", // Assuming standard bank account
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "ZAR",
    });
    return response.data;
  } catch (error: any) {
    console.error("Paystack Recipient Error:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Failed to create transfer recipient");
  }
};

/**
 * Initiate a Transfer to Seller
 */
export const initiateTransfer = async (amount: number, recipient: string, reason: string) => {
  try {
    const response = await paystack.post("/transfer", {
      source: "balance",
      amount: amount * 100,
      recipient,
      reason,
      currency: "ZAR",
    });
    return response.data;
  } catch (error: any) {
    console.error("Paystack Transfer Error:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Failed to initiate transfer");
  }
};

/**
 * Refund a Transaction to Buyer
 */
export const refundTransaction = async (transactionReference: string) => {
  try {
    const response = await paystack.post("/refund", {
      transaction: transactionReference,
    });
    return response.data;
  } catch (error: any) {
    console.error("Paystack Refund Error:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Failed to issue refund");
  }
};

/**
 * Verify a Transaction
 */
export const verifyTransaction = async (reference: string) => {
  try {
    const response = await paystack.get(`/transaction/verify/${reference}`);
    return response.data;
  } catch (error: any) {
    console.error("Paystack Verify Error:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Failed to verify transaction");
  }
};
