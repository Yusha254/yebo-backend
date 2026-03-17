import africastalking from "africastalking";

// Init Africa's Talking
const at = africastalking({
  apiKey: process.env.AT_API_KEY as string,
  username: process.env.AT_USERNAME as string, // "sandbox" for testing
});

const sms = at.SMS;

// Normalize numbers: 07xxxxx → +2547xxxxx
export function normalizeNumber(number: string): string {
  const clean = number.replace(/\D/g, "");

  if (clean.startsWith("07")) {
    return "+27" + clean.slice(1);
  } else if (clean.startsWith("7")) {
    return "+27" + clean;
  } else if (clean.startsWith("27")) {
    return "+" + clean;
  } else if (number.startsWith("+27")) {
    return number;
  } else {
    return number;
  }
}

// Define response type (based on Africa's Talking docs)
export interface SMSRecipient {
  number: string;
  status: string;
  statusCode: number;
  cost: string;
  messageId: string;
}

export interface SMSResponse {
  SMSMessageData: {
    Message: string;
    Recipients: SMSRecipient[];
  };
}
interface SMSOptions {
    to: string[];
    message: string;
    from?: string; // optional
  }

export async function sendSMS(to: string, message: string): Promise<SMSResponse> {
    const recipient = normalizeNumber(to);
  
    const payload: SMSOptions = {
      to: [recipient],
      message,
      // from is optional now
    };
  
    const rawResponse = await (sms.send as (opts: SMSOptions) => Promise<unknown>)(payload);
  
    return rawResponse as SMSResponse;
  }
  
