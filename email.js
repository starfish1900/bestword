const nodemailer = require('nodemailer');

// Amazon SES SMTP configuration
// Requires environment variables: SES_SMTP_HOST, SES_SMTP_USER, SES_SMTP_PASS
const transporter = nodemailer.createTransport({
  host: process.env.SES_SMTP_HOST || 'email-smtp.us-east-1.amazonaws.com',
  port: 587,
  secure: false, // STARTTLS
  auth: {
    user: process.env.SES_SMTP_USER,
    pass: process.env.SES_SMTP_PASS
  }
});

// Verify transporter configuration on startup
async function verifyMailConfig() {
  try {
    await transporter.verify();
    console.log('Amazon SES SMTP connection verified');
    return true;
  } catch (err) {
    console.error('Amazon SES SMTP verification failed:', err.message);
    console.error('Make sure SES_SMTP_HOST, SES_SMTP_USER, and SES_SMTP_PASS environment variables are set');
    return false;
  }
}

// Send verification email
async function sendVerificationEmail(email, username, token) {
  const baseUrl = process.env.BASE_URL || 'https://bestword.net';
  const verifyUrl = `${baseUrl}/auth/verify?token=${token}`;

  const mailOptions = {
    from: '"BestWord" <noreply@bestword.net>',
    to: email,
    subject: 'BestWord — Verify your email',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0f1117; color: #e8e6e3; border-radius: 12px;">
        <h1 style="color: #e8a946; font-size: 28px; margin-bottom: 8px;">BestWord</h1>
        <p style="font-size: 16px; line-height: 1.6;">
          Hello <strong>${username}</strong>,
        </p>
        <p style="font-size: 15px; line-height: 1.6; color: #9ea3b0;">
          Thank you for signing up! Please verify your email address by clicking the button below.
        </p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${verifyUrl}" style="background: #e8a946; color: #0f1117; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
            Verify Email
          </a>
        </div>
        <p style="font-size: 13px; color: #9ea3b0; line-height: 1.5;">
          Or copy and paste this link into your browser:<br>
          <a href="${verifyUrl}" style="color: #5b8def; word-break: break-all;">${verifyUrl}</a>
        </p>
        <p style="font-size: 12px; color: #666; margin-top: 24px;">
          This link expires in 24 hours. If you did not sign up for BestWord, please ignore this email.
        </p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
}

module.exports = { verifyMailConfig, sendVerificationEmail };
