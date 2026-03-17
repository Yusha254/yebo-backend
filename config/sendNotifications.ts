// notifications.ts
import { Expo } from "expo-server-sdk";

// Create a new Expo SDK client
const expo = new Expo();

/**
 * Send push notifications to a list of Expo tokens
 */
export async function sendPushNotification(tokens: string[], title: string, body: string,type: "transactions" | "messages",actions?: { identifier: string; buttonTitle: string }[] , extra: Record<string, unknown> = {}) {
  // Filter out invalid tokens
  const validTokens = tokens.filter((token) => Expo.isExpoPushToken(token));

  // Build notification messages
  const messages = validTokens.map((token) => ({
    to: token,
    sound: "default",
    title,
    body,
    data: {
      type,
      actions,              // 👈 used by your handler
      ...extra           // 👈 include trans_id, chat_id, etc.
    },
    actions
  }));

  // Split into chunks (Expo requires this)
  const chunks = expo.chunkPushNotifications(messages);
  const tickets: any[] = [];

  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    } catch (error) {
      console.error("Error sending push notification", error);
    }
  }

  return tickets;
}
