import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from '../lib/logger.js';

const SMTP_HOST = process.env.SMTP_HOST ?? '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT ?? '587', 10);
const SMTP_USER = process.env.SMTP_USER ?? '';
const SMTP_PASS = process.env.SMTP_PASS ?? '';
const SMTP_FROM = process.env.SMTP_FROM ?? 'noreply@orcy.local';

let transporter: Transporter | null = null;

export function isConfigured(): boolean {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

function getTransporter(): Transporter | null {
  if (!isConfigured()) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  return transporter;
}

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(payload: EmailPayload): Promise<boolean> {
  const transport = getTransporter();
  if (!transport) {
    logger.warn({ to: payload.to }, 'SMTP not configured — skipping email');
    return false;
  }

  try {
    await transport.sendMail({
      from: SMTP_FROM,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
    });
    return true;
  } catch (err) {
    logger.error({ err, to: payload.to }, 'Failed to send email');
    return false;
  }
}

function baseTemplate(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="background: #4f46e5; padding: 20px; color: #fff;">
      <h1 style="margin: 0; font-size: 18px;">Orcy</h1>
    </div>
    <div style="padding: 24px;">
      <h2 style="margin: 0 0 16px; font-size: 16px; color: #1f2937;">${title}</h2>
      ${bodyHtml}
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
      <p style="margin: 0; font-size: 12px; color: #9ca3af;">You received this email because of your notification preferences in Orcy.</p>
    </div>
  </div>
</body>
</html>`;
}

export function taskAssignedTemplate(taskTitle: string, habitatName: string, assignedBy: string): EmailPayload {
  return {
    to: '',
    subject: `Task assigned to you: ${taskTitle}`,
    html: baseTemplate(
      'Task Assigned',
      `<p style="margin: 0 0 12px; color: #374151;">You have been assigned a task.</p>
       <table style="width: 100%; border-collapse: collapse;">
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Task:</td><td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${taskTitle}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Habitat:</td><td style="padding: 8px 0; color: #1f2937;">${habitatName}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Assigned by:</td><td style="padding: 8px 0; color: #1f2937;">${assignedBy}</td></tr>
       </table>`
    ),
  };
}

export function taskSubmittedTemplate(taskTitle: string, habitatName: string, agentName: string): EmailPayload {
  return {
    to: '',
    subject: `Task submitted for review: ${taskTitle}`,
    html: baseTemplate(
      'Task Submitted for Review',
      `<p style="margin: 0 0 12px; color: #374151;">A task has been submitted for review.</p>
       <table style="width: 100%; border-collapse: collapse;">
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Task:</td><td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${taskTitle}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Habitat:</td><td style="padding: 8px 0; color: #1f2937;">${habitatName}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Submitted by:</td><td style="padding: 8px 0; color: #1f2937;">${agentName}</td></tr>
       </table>`
    ),
  };
}

export function taskApprovedTemplate(taskTitle: string, habitatName: string, reviewerName: string): EmailPayload {
  return {
    to: '',
    subject: `Task approved: ${taskTitle}`,
    html: baseTemplate(
      'Task Approved',
      `<p style="margin: 0 0 12px; color: #374151;">Your task has been approved.</p>
       <table style="width: 100%; border-collapse: collapse;">
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Task:</td><td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${taskTitle}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Habitat:</td><td style="padding: 8px 0; color: #1f2937;">${habitatName}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Approved by:</td><td style="padding: 8px 0; color: #1f2937;">${reviewerName}</td></tr>
       </table>`
    ),
  };
}

export function taskRejectedTemplate(taskTitle: string, habitatName: string, reviewerName: string, reason: string): EmailPayload {
  return {
    to: '',
    subject: `Task rejected: ${taskTitle}`,
    html: baseTemplate(
      'Task Rejected',
      `<p style="margin: 0 0 12px; color: #374151;">Your task has been rejected.</p>
       <table style="width: 100%; border-collapse: collapse;">
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Task:</td><td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${taskTitle}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Habitat:</td><td style="padding: 8px 0; color: #1f2937;">${habitatName}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Rejected by:</td><td style="padding: 8px 0; color: #1f2937;">${reviewerName}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Reason:</td><td style="padding: 8px 0; color: #ef4444;">${reason}</td></tr>
       </table>`
    ),
  };
}

export function taskOverdueTemplate(taskTitle: string, habitatName: string, deadline: string): EmailPayload {
  return {
    to: '',
    subject: `Task overdue: ${taskTitle}`,
    html: baseTemplate(
      'Task Overdue',
      `<p style="margin: 0 0 12px; color: #374151;">A task has passed its deadline.</p>
       <table style="width: 100%; border-collapse: collapse;">
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Task:</td><td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${taskTitle}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Habitat:</td><td style="padding: 8px 0; color: #1f2937;">${habitatName}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Deadline:</td><td style="padding: 8px 0; color: #ef4444;">${deadline}</td></tr>
       </table>`
    ),
  };
}

export function commentMentionedTemplate(taskTitle: string, habitatName: string, mentionedByName: string, commentContent: string): EmailPayload {
  return {
    to: '',
    subject: `You were mentioned in: ${taskTitle}`,
    html: baseTemplate(
      'You Were Mentioned',
      `<p style="margin: 0 0 12px; color: #374151;">You were mentioned in a comment.</p>
       <table style="width: 100%; border-collapse: collapse;">
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Task:</td><td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${taskTitle}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Habitat:</td><td style="padding: 8px 0; color: #1f2937;">${habitatName}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Mentioned by:</td><td style="padding: 8px 0; color: #1f2937;">${mentionedByName}</td></tr>
       </table>
       <div style="margin-top: 12px; padding: 12px; background: #f9fafb; border-radius: 6px; border-left: 3px solid #4f46e5;">
         <p style="margin: 0; font-size: 14px; color: #374151;">${commentContent}</p>
       </div>`
    ),
  };
}

export function taskWatchingTemplate(taskTitle: string, habitatName: string, eventType: string): EmailPayload {
  return {
    to: '',
    subject: `Watched task updated: ${taskTitle}`,
    html: baseTemplate(
      'Watched Task Updated',
      `<p style="margin: 0 0 12px; color: #374151;">A task you are watching has been updated.</p>
       <table style="width: 100%; border-collapse: collapse;">
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Task:</td><td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${taskTitle}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Habitat:</td><td style="padding: 8px 0; color: #1f2937;">${habitatName}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Event:</td><td style="padding: 8px 0; color: #1f2937;">${eventType}</td></tr>
       </table>`
    ),
  };
}

export function anomalyAlertTemplate(anomalyType: string, severity: string, message: string, habitatName: string): EmailPayload {
  const severityColors: Record<string, string> = { low: '#3b82f6', medium: '#f59e0b', high: '#f97316', critical: '#ef4444' };
  const color = severityColors[severity] ?? '#6b7280';
  return {
    to: '',
    subject: `[Anomaly Alert] ${anomalyType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} — ${severity.toUpperCase()}`,
    html: baseTemplate(
      'Anomaly Detected',
      `<p style="margin: 0 0 12px; color: #374151;">An anomaly has been detected on your habitat.</p>
       <table style="width: 100%; border-collapse: collapse;">
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Habitat:</td><td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${habitatName}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Type:</td><td style="padding: 8px 0; color: #1f2937;">${anomalyType.replace(/_/g, ' ')}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Severity:</td><td style="padding: 8px 0; font-weight: 600; color: ${color};">${severity.toUpperCase()}</td></tr>
       </table>
       <div style="margin-top: 12px; padding: 12px; background: #f9fafb; border-radius: 6px; border-left: 3px solid ${color};">
          <p style="margin: 0; font-size: 14px; color: #374151;">${message}</p>
        </div>`
    ),
  };
}

export function priorityChangedTemplate(taskTitle: string, habitatName: string, oldPriority: string, newPriority: string): EmailPayload {
  const priorityColors: Record<string, string> = { low: '#3b82f6', medium: '#6b7280', high: '#f59e0b', critical: '#ef4444' };
  return {
    to: '',
    subject: `Task priority changed: ${taskTitle}`,
    html: baseTemplate(
      'Task Priority Changed',
      `<p style="margin: 0 0 12px; color: #374151;">A task's priority has been updated.</p>
       <table style="width: 100%; border-collapse: collapse;">
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Task:</td><td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${taskTitle}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Habitat:</td><td style="padding: 8px 0; color: #1f2937;">${habitatName}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">From:</td><td style="padding: 8px 0; font-weight: 600; color: ${priorityColors[oldPriority] ?? '#6b7280'};">${oldPriority.toUpperCase()}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">To:</td><td style="padding: 8px 0; font-weight: 600; color: ${priorityColors[newPriority] ?? '#6b7280'};">${newPriority.toUpperCase()}</td></tr>
       </table>`
    ),
  };
}

export function reviewAssignedTemplate(taskTitle: string, habitatName: string, assignedBy: string): EmailPayload {
  return {
    to: '',
    subject: `Review requested: ${taskTitle}`,
    html: baseTemplate(
      'Review Requested',
      `<p style="margin: 0 0 12px; color: #374151;">You have been assigned to review a task.</p>
       <table style="width: 100%; border-collapse: collapse;">
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Task:</td><td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${taskTitle}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Habitat:</td><td style="padding: 8px 0; color: #1f2937;">${habitatName}</td></tr>
         <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Requested by:</td><td style="padding: 8px 0; color: #1f2937;">${assignedBy}</td></tr>
       </table>`
    ),
  };
}
