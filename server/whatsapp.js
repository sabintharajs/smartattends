import pool from './db.js';

const escapeTemplateValue = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export async function deliverNotification(notificationId) {
  console.log('[WhatsApp] Starting delivery:', notificationId);
  const [claim] = await pool.execute(
    `UPDATE WhatsApp_Notifications n
     JOIN Attendance a ON a.id=n.attendance_id
     JOIN Students s ON s.id=a.student_id
     SET n.status='sending', n.attempts=n.attempts + 1, n.error_message=NULL
     WHERE n.id=? AND n.recipient_type='parent'
       AND n.status IN ('pending', 'failed')
       AND a.status='absent' AND s.parent_whatsapp_consent=TRUE`,
    [notificationId],
  );
 console.log('[WhatsApp] Claim result:', claim.affectedRows);

if (!claim.affectedRows) return;

  const token = process.env.META_WHATSAPP_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const templateName = process.env.META_WHATSAPP_TEMPLATE;
  const templateLanguage = process.env.META_WHATSAPP_TEMPLATE_LANGUAGE || 'en';
  if (!token || !phoneNumberId || !templateName) {
    await pool.execute(
      `UPDATE WhatsApp_Notifications SET status='failed', error_message=?
       WHERE id=? AND status='sending'`,
      ['WhatsApp Cloud API credentials or approved message template are not configured.', notificationId],
    );
    return;
  }

  const [rows] = await pool.execute(
    `SELECT n.recipient_number AS recipientNumber,
            s.name AS studentName, s.register_number AS registerNumber,
            d.name AS department, c.year, c.section, a.attendance_date AS attendanceDate
     FROM WhatsApp_Notifications n
     JOIN Attendance a ON a.id=n.attendance_id
     JOIN Students s ON s.id=a.student_id
     JOIN Classes c ON c.id=a.class_id
     JOIN Departments d ON d.id=c.department_id
     WHERE n.id=? AND n.status='sending'
       AND n.recipient_type='parent' AND a.status='absent'
       AND s.parent_whatsapp_consent=TRUE`,
    [notificationId],
  );
  const notification = rows[0];
  if (!notification) {
    await pool.execute(
      `UPDATE WhatsApp_Notifications SET status='corrected',
         error_message='Attendance was corrected or guardian consent was withdrawn.'
       WHERE id=? AND status='sending'`,
      [notificationId],
    );
    return;
  }

  try {
    const date = String(notification.attendanceDate).slice(0, 10);
    const response = await fetch(
      `https://graph.facebook.com/${process.env.META_API_VERSION || 'v21.0'}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: notification.recipientNumber.replace(/\D/g, ''),
          type: 'template',
          template: {
            name: templateName,
            language: { code: templateLanguage },
            components: [{
              type: 'body',
              parameters: [
                { type: 'text', text: escapeTemplateValue(notification.studentName) },
                { type: 'text', text: escapeTemplateValue(notification.registerNumber) },
                { type: 'text', text: `${notification.department}, ${notification.year}/${notification.section}` },
                { type: 'text', text: date },
              ],
            }],
          },
        }),
      },
    );
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error?.message || `WhatsApp API returned ${response.status}`);
    }
    if (!result.messages?.[0]?.id) {
      throw new Error('WhatsApp API did not return a message ID.');
    }
    await pool.execute(
      `UPDATE WhatsApp_Notifications
       SET status='sent', provider_message_id=?, error_message=NULL
       WHERE id=? AND status='sending'`,
      [result.messages[0].id, notificationId],
    );
  } catch (error) {
    await pool.execute(
      `UPDATE WhatsApp_Notifications SET status='failed', error_message=?
       WHERE id=? AND status='sending'`,
      [String(error.message || 'WhatsApp delivery failed.').slice(0, 500), notificationId],
    );
  }
}

export async function createAbsenceNotifications(connection, attendanceId, student, context) {
  if (!student.parent_whatsapp_consent || !student.parent_whatsapp) return;

  const attendanceDate = String(context.attendanceDate).slice(0, 10);
  await connection.execute('SELECT id FROM Students WHERE id=? FOR UPDATE', [student.id]);
  const [existingNotifications] = await connection.execute(
    `SELECT n.id FROM WhatsApp_Notifications n
     JOIN Attendance a ON a.id=n.attendance_id
     WHERE a.student_id=? AND a.class_id=? AND a.attendance_date=?
       AND n.recipient_type='parent' LIMIT 1 FOR UPDATE`,
    [student.id, student.class_id, attendanceDate],
  );
  if (existingNotifications.length) return;

  const message = [
    'Dear Parent/Guardian,',
    '',
    `Your ward ${student.name}, Register Number ${student.register_number}, studying in ${student.department}, ${student.year}/${student.section}, has been marked ABSENT on ${attendanceDate}.`,
    '',
    'Please contact the college if you need any clarification.',
    '',
    'Regards,',
    'College Administration Team',
  ].join('\n');

  await connection.execute(
    `INSERT INTO WhatsApp_Notifications
      (attendance_id, cycle_number, recipient_type, recipient_number, message, status)
     VALUES (?, 1, 'parent', ?, ?, 'pending')
     ON DUPLICATE KEY UPDATE id=id`,
    [attendanceId, student.parent_whatsapp, message],
  );
}
