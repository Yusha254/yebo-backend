import nodemailer, { SentMessageInfo } from "nodemailer";
require('dotenv').config();
type EmailType = "verify" | "reset" | "welcome" | "notification";

type SendEmailFn = (
  to: string,
  type: EmailType,
  code?: string
) => Promise<SentMessageInfo>;

const sendEmail: SendEmailFn = async (to, type, code) => {
  // Switch transporter based on environment
  const transporter = process.env.NODE_ENV === "production"
    ? nodemailer.createTransport({
      host: "mail.yebovoucher.africa",
      port: 465,
      secure: true,
      auth: {
        user: "no-reply@yebovoucher.africa",
        pass: process.env.MAIL_PASSWORD,
      },
    }) : nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: await nodemailer.createTestAccount(),
    });
  let subject: string;
  let html: string;

  switch (type) {
    case "verify":
      subject = "Verify your email";
      html = ` <h1>YeboVoucher </h1><p><b>${code}</b> is your verification code. </p>`;
      break;
    case "reset":
      subject = "Password Reset";
      html = `<p><b>${code}</b> Use this code to reset your password.</p>`;
      break;
    case "welcome":
      subject = "Welcome 🎉";
      html = `<p>Thanks for joining us! Enjoy your stay.</p>`;
      break;
    default:
      subject = "Notification";
      html = `<p>${code || "Hello!"}</p>`;
  }

  // Send mail
  const info = await transporter.sendMail({
    from: '"Yebo Voucher" <no-reply@yebovoucher.africa>',
    to,
    subject,
    html,
  });

  if (process.env.NODE_ENV !== "production") {
    console.log("Preview URL:", nodemailer.getTestMessageUrl(info));
  }

  return info;
};

export default sendEmail;
