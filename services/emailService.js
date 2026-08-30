const nodemailer = require('nodemailer');
const { formatCurrency, formatTime12 } = require('../utils/dateTimeUtils');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.ethereal.email',
      port: parseInt(process.env.SMTP_PORT, 10) || 587,
      auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || ''
      }
    });
  }
  return transporter;
}

async function sendReservationConfirmation(reservation, court) {
  if (!reservation.user_email) {
    return { success: false, reason: 'No email address provided' };
  }

  const courtName = court ? court.display_name : 'Pickleball Court';
  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
      <div style="background-color: #198754; color: white; padding: 15px; text-align: center; border-radius: 6px 6px 0 0;">
        <h2 style="margin: 0;">PicklePlay Pro</h2>
        <p style="margin: 5px 0 0 0; font-size: 14px;">Reservation Confirmed</p>
      </div>
      <div style="padding: 20px;">
        <p>Hi <strong>${reservation.user_name}</strong>,</p>
        <p>Your pickleball court reservation has been successfully confirmed!</p>
        
        <div style="background-color: #f8f9fa; border-left: 4px solid #198754; padding: 15px; margin: 20px 0;">
          <p style="margin: 0 0 8px 0;"><strong>Reference Number:</strong> <span style="font-family: monospace; font-size: 16px; color: #0d6efd;">${reservation.reference_number}</span></p>
          <p style="margin: 0 0 8px 0;"><strong>Court:</strong> ${courtName}</p>
          <p style="margin: 0 0 8px 0;"><strong>Date:</strong> ${reservation.reservation_date}</p>
          <p style="margin: 0 0 8px 0;"><strong>Time:</strong> ${formatTime12(reservation.start_time)} - ${formatTime12(reservation.end_time)} (${reservation.total_hours} hr/s)</p>
          <p style="margin: 0;"><strong>Total Paid:</strong> ${formatCurrency(reservation.total_amount)} via GCash</p>
        </div>

        <p style="font-size: 13px; color: #6c757d;">Please present this confirmation upon arrival at the court facility. Have a great game!</p>
      </div>
      <div style="text-align: center; font-size: 12px; color: #999; padding-top: 15px; border-top: 1px solid #eee;">
        &copy; ${new Date().getFullYear()} PicklePlay Pro Court Reservation System.
      </div>
    </div>
  `;

  try {
    const info = await getTransporter().sendMail({
      from: '"PicklePlay Pro" <noreply@pickleplay.com>',
      to: reservation.user_email,
      subject: `Reservation Confirmed - ${reservation.reference_number} (PicklePlay Pro)`,
      html: emailHtml
    });
    console.log(`[Email Service] Confirmation email sent to ${reservation.user_email}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.log(`[Email Service Mock] Email to ${reservation.user_email}: Confirmed booking ${reservation.reference_number}`);
    return { success: true, mocked: true };
  }
}

module.exports = { sendReservationConfirmation };
