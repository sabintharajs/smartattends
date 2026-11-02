import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import pool from './db.js';
import { authenticate, allowRoles } from './auth.js';
import { createAbsenceNotifications, deliverNotification } from './whatsapp.js';

const app = express();
const port = Number(process.env.PORT || 4000);
const serverDirectory = dirname(fileURLToPath(import.meta.url));
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters.');
}

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buffer) => { req.rawBody = buffer; },
}));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }));
app.use('/api/auth/register', rateLimit({ windowMs: 15 * 60 * 1000, limit: 5 }));
app.use('/api/auth/forgot-password', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  handler: (req, res) => res.status(429).json({
    error: 'Too many password reset requests. Please wait 15 minutes before trying again.',
  }),
}));
app.use('/api/auth/reset-password', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }));

const loginSchema = z.object({
  loginId: z.string().trim().min(1).max(190),
  password: z.string().min(1).max(72).refine((value) => Buffer.byteLength(value) <= 72),
  role: z.enum(['admin', 'faculty', 'hod', 'student']),
});

const passwordSchema = z.string().min(12).max(72).refine((value) => Buffer.byteLength(value) <= 72);
const resetPasswordSchema = z.string()
  .min(12, 'Password must be at least 12 characters.')
  .max(72, 'Password must be no more than 72 characters.')
  .refine((value) => Buffer.byteLength(value) <= 72, 'Password must be no more than 72 bytes.')
  .refine((value) => /[a-z]/.test(value), 'Password must contain a lowercase letter.')
  .refine((value) => /[A-Z]/.test(value), 'Password must contain an uppercase letter.')
  .refine((value) => /\d/.test(value), 'Password must contain a number.')
  .refine((value) => /[^A-Za-z0-9]/.test(value), 'Password must contain a symbol.');
const resetRequestMessage = 'If an active account matches, a password-reset link will be sent to its registered email. If you do not receive one, contact your college administrator.';
const resetEmailNotConfiguredMessage = 'Password-reset email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and MAIL_FROM in .env, then restart the API.';
const resetEmailUnavailableMessage = 'Password-reset email is currently unavailable. Please try again later or contact your college administrator.';
const resetTokenLifetimeMinutes = 30;
const mailReady = Boolean(
  process.env.SMTP_HOST
  && process.env.SMTP_USER
  && process.env.SMTP_PASSWORD
  && process.env.MAIL_FROM,
);
const mailTransport = mailReady
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    family: 4,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  })
  : null;

const registrationSchemas = {
  faculty: z.object({
    role: z.literal('faculty'),
    facultyCode: z.string().trim().min(1).max(40),
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(190),
    departmentId: z.number().int().positive(),
    password: passwordSchema,
  }),
  student: z.object({
    role: z.literal('student'),
    name: z.string().trim().min(2).max(120),
    registerNumber: z.string().trim().min(1).max(40),
    rollNumber: z.string().trim().min(1).max(30),
    classId: z.number().int().positive(),
    email: z.string().trim().email().max(190),
    parentName: z.string().trim().max(120).optional().default(''),
    parentWhatsApp: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/).or(z.literal('')).optional().default(''),
    parentWhatsAppConsent: z.boolean().optional().default(false),
    password: passwordSchema,
  }).refine((value) => !value.parentWhatsAppConsent || Boolean(value.parentWhatsApp), {
    message: 'A parent WhatsApp number is required to record consent.',
    path: ['parentWhatsAppConsent'],
  }),
  hod: z.object({
    role: z.literal('hod'),
    name: z.string().trim().min(2).max(120),
    loginId: z.string().trim().min(1).max(190),
    email: z.string().trim().email().max(190),
    departmentId: z.number().int().positive(),
    whatsappNumber: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/),
    password: passwordSchema,
  }),
};

app.post('/api/auth/forgot-password', async (req, res, next) => {
  let connection;
  try {
    const { identifier } = z.object({
      identifier: z.string().trim().min(1).max(190),
    }).parse(req.body);
    if (!mailTransport) return res.status(503).json({ error: resetEmailNotConfiguredMessage });
    try {
      await mailTransport.verify();
    } catch (mailError) {
      console.error('Password reset email service is unavailable:', mailError.code || mailError.name || 'SMTP error');
      return res.status(503).json({ error: resetEmailUnavailableMessage });
    }
    await pool.query('SELECT id FROM Password_Reset_Tokens LIMIT 0');

    const normalizedIdentifier = identifier.toLowerCase();
    const [users] = await pool.execute(
      `SELECT u.id, u.login_id AS loginId, u.role,
              COALESCE(a.email, f.email, s.email, h.email) AS email,
              COALESCE(a.name, f.name, s.name, h.name, u.login_id) AS displayName
       FROM Users u
       LEFT JOIN Admin a ON u.role='admin' AND a.id=u.linked_id
       LEFT JOIN Faculty f ON u.role='faculty' AND f.id=u.linked_id
       LEFT JOIN Students s ON u.role='student' AND s.id=u.linked_id
       LEFT JOIN HOD_Contacts h ON u.role='hod' AND h.department_id=u.linked_id
       WHERE u.active=TRUE AND (
         LOWER(u.login_id)=? OR LOWER(COALESCE(a.email, ''))=?
         OR LOWER(COALESCE(f.email, ''))=? OR LOWER(COALESCE(s.email, ''))=?
         OR LOWER(COALESCE(h.email, ''))=?
       )`,
      Array(5).fill(normalizedIdentifier),
    );
    const accounts = users.filter((user) => user.email);
    if (!accounts.length) return res.json({ message: resetRequestMessage });

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const resetLinks = [];
    for (const account of accounts) {
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      await connection.execute(
        `UPDATE Password_Reset_Tokens
         SET used_at=UTC_TIMESTAMP()
         WHERE user_id=? AND used_at IS NULL`,
        [account.id],
      );
      await connection.execute(
        `INSERT INTO Password_Reset_Tokens (user_id, token_hash, expires_at)
         VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))`,
        [account.id, tokenHash, resetTokenLifetimeMinutes],
      );
      resetLinks.push({ ...account, token, tokenHash });
    }
    await connection.commit();
    connection.release();
    connection = null;

    const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    for (const reset of resetLinks) {
      const resetUrl = new URL('/', origin);
      resetUrl.searchParams.set('reset', reset.token);
      try {
        await mailTransport.sendMail({
          from: process.env.MAIL_FROM,
          to: reset.email,
          subject: 'Reset your Smart Attendance password',
          text: `Hello ${reset.displayName},\n\nUse this secure link to reset your password. It expires in ${resetTokenLifetimeMinutes} minutes and can only be used once:\n\n${resetUrl.href}\n\nIf you did not request this, you can ignore this email.`,
          html: `<p>Hello ${escapeHtml(reset.displayName)},</p><p>Use this secure link to reset your Smart Attendance password. It expires in ${resetTokenLifetimeMinutes} minutes and can only be used once.</p><p><a href="${escapeHtml(resetUrl.href)}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`,
        });
      } catch (mailError) {
        await pool.execute(
          `UPDATE Password_Reset_Tokens SET used_at=UTC_TIMESTAMP()
           WHERE token_hash=? AND used_at IS NULL`,
          [reset.tokenHash],
        );
        console.error('Password reset email delivery failed:', {
          code: mailError.code || mailError.name || 'SMTP error',
          command: mailError.command,
          responseCode: mailError.responseCode,
        });
      }
    }
    res.json({ message: resetRequestMessage });
  } catch (error) {
    if (connection) await connection.rollback();
    if (['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(error.code)) {
      console.error('Password reset database schema is incomplete. Run database/schema.sql.');
      return res.status(503).json({ error: 'Password recovery database setup is incomplete. Apply database/schema.sql, then restart the API.' });
    }
    next(error);
  } finally {
    connection?.release();
  }
});

app.post('/api/auth/reset-password', async (req, res, next) => {
  let connection;
  try {
    const input = z.object({
      token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'This password reset link is invalid or expired.'),
      password: resetPasswordSchema,
      confirmPassword: z.string(),
    }).refine((value) => value.password === value.confirmPassword, {
      message: 'Passwords do not match.',
      path: ['confirmPassword'],
    }).parse(req.body);
    const tokenHash = createHash('sha256').update(input.token).digest('hex');
    const passwordHash = await bcrypt.hash(input.password, 12);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [[reset]] = await connection.execute(
      `SELECT t.id, t.user_id AS userId, u.role, u.linked_id AS linkedId
       FROM Password_Reset_Tokens t JOIN Users u ON u.id=t.user_id
       WHERE t.token_hash=? AND t.used_at IS NULL
         AND t.expires_at > UTC_TIMESTAMP() AND u.active=TRUE
       FOR UPDATE`,
      [tokenHash],
    );
    if (!reset) {
      await connection.rollback();
      return res.status(400).json({ error: 'This password reset link is invalid or expired. Request a new one.' });
    }
    const [updated] = await connection.execute(
      'UPDATE Users SET password_hash=? WHERE id=? AND active=TRUE',
      [passwordHash, reset.userId],
    );
    if (!updated.affectedRows) {
      await connection.rollback();
      return res.status(400).json({ error: 'This password reset link is invalid or expired. Request a new one.' });
    }
    if (reset.role === 'admin') {
      await connection.execute(
        'UPDATE Admin SET password_hash=? WHERE id=?',
        [passwordHash, reset.linkedId],
      );
    }
    await connection.execute(
      `UPDATE Password_Reset_Tokens SET used_at=UTC_TIMESTAMP()
       WHERE user_id=? AND used_at IS NULL`,
      [reset.userId],
    );
    await connection.commit();
    res.json({ message: 'Your password has been reset. You can now sign in.' });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    connection?.release();
  }
});

app.post('/api/admin/password-reset', authenticate, allowRoles('admin'), async (req, res, next) => {
  let connection;
  try {
    const input = z.object({
      loginId: z.string().trim().min(1).max(190),
      password: resetPasswordSchema,
      confirmPassword: z.string(),
    }).refine((value) => value.password === value.confirmPassword, {
      message: 'Passwords do not match.',
      path: ['confirmPassword'],
    }).parse(req.body);
    const passwordHash = await bcrypt.hash(input.password, 12);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [[user]] = await connection.execute(
      'SELECT id, role, linked_id AS linkedId FROM Users WHERE login_id=? AND active=TRUE FOR UPDATE',
      [input.loginId],
    );
    if (!user) {
      await connection.rollback();
      return res.status(404).json({ error: 'No active account was found with that login ID.' });
    }
    await connection.execute(
      'UPDATE Users SET password_hash=? WHERE id=?',
      [passwordHash, user.id],
    );
    if (user.role === 'admin') {
      await connection.execute(
        'UPDATE Admin SET password_hash=? WHERE id=?',
        [passwordHash, user.linkedId],
      );
    }
    await connection.execute(
      `UPDATE Password_Reset_Tokens SET used_at=UTC_TIMESTAMP()
       WHERE user_id=? AND used_at IS NULL`,
      [user.id],
    );
    await connection.commit();
    res.json({ message: 'Password reset successfully. The account can sign in with the new password.' });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    connection?.release();
  }
});

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

app.get('/api/auth/options', async (req, res, next) => {
  try {
    const [departments] = await pool.query('SELECT id, name FROM Departments ORDER BY name');
    const [classes] = await pool.query(
      `SELECT c.id, c.year, c.section, c.academic_year AS academicYear,
              d.name AS department
       FROM Classes c JOIN Departments d ON d.id=c.department_id
       ORDER BY d.name, c.year, c.section`,
    );
    res.json({ departments, classes });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/register', async (req, res, next) => {
  let connection;
  try {
    const schema = registrationSchemas[req.body?.role];
    if (!schema) return res.status(400).json({ error: 'Choose a supported registration type.' });
    const input = schema.parse(req.body);
    const loginId = input.role === 'faculty' ? input.facultyCode
      : input.role === 'student' ? input.email : input.loginId;
    const { password, ...profile } = input;
    const passwordHash = await bcrypt.hash(password, 12);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [[existingUser]] = await connection.execute(
      'SELECT id FROM Users WHERE login_id=? LIMIT 1',
      [loginId],
    );
    if (existingUser) {
      await connection.rollback();
      return res.status(409).json({ error: 'That login ID is already in use.' });
    }
    if (input.role === 'faculty') {
      const [[department]] = await connection.execute(
        'SELECT id FROM Departments WHERE id=?',
        [input.departmentId],
      );
      if (!department) {
        await connection.rollback();
        return res.status(400).json({ error: 'Choose an existing department.' });
      }
      const [[duplicateFaculty]] = await connection.execute(
        'SELECT id FROM Faculty WHERE faculty_code=? OR email=? LIMIT 1',
        [input.facultyCode, input.email],
      );
      if (duplicateFaculty) {
        await connection.rollback();
        return res.status(409).json({ error: 'That faculty ID or email address is already registered.' });
      }
    } else if (input.role === 'student') {
      const [[classRecord]] = await connection.execute(
        'SELECT id FROM Classes WHERE id=?',
        [input.classId],
      );
      if (!classRecord) {
        await connection.rollback();
        return res.status(400).json({ error: 'Choose an existing class.' });
      }
      const [[duplicateStudent]] = await connection.execute(
        'SELECT id FROM Students WHERE register_number=? OR email=? LIMIT 1',
        [input.registerNumber, input.email],
      );
      if (duplicateStudent) {
        await connection.rollback();
        return res.status(409).json({ error: 'That register number or email address is already registered.' });
      }
    } else {
      const [[department]] = await connection.execute(
        'SELECT id FROM Departments WHERE id=?',
        [input.departmentId],
      );
      if (!department) {
        await connection.rollback();
        return res.status(400).json({ error: 'Choose an existing department.' });
      }
      const [[existingHod]] = await connection.execute(
        `SELECT id FROM Users WHERE role='hod' AND linked_id=? AND active=TRUE`,
        [input.departmentId],
      );
      if (existingHod) {
        await connection.rollback();
        return res.status(409).json({ error: 'An active HOD account already exists for this department.' });
      }
    }
    const [[existingRequest]] = await connection.execute(
      'SELECT id, status FROM Registration_Requests WHERE login_id=? FOR UPDATE',
      [loginId],
    );
    if (existingRequest?.status === 'pending') {
      await connection.rollback();
      return res.status(409).json({ error: 'A registration request for that login ID is already pending.' });
    }
    if (existingRequest) {
      await connection.execute(
        `UPDATE Registration_Requests
         SET role=?, password_hash=?, profile=?, status='pending', created_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [input.role, passwordHash, JSON.stringify(profile), existingRequest.id],
      );
    } else {
      await connection.execute(
        `INSERT INTO Registration_Requests (role, login_id, password_hash, profile)
         VALUES (?, ?, ?, ?)`,
        [input.role, loginId, passwordHash, JSON.stringify(profile)],
      );
    }
    await connection.commit();
    res.status(202).json({ message: 'Your request was sent to a college administrator for approval.' });
  } catch (error) {
    if (connection) await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That login ID is already in use or has a pending registration.' });
    }
    if (['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(error.code)) {
      console.error('Registration database schema is incomplete. Run database/schema.sql before accepting registrations.');
      return res.status(503).json({ error: 'Registration is temporarily unavailable because the database schema is incomplete. Contact the administrator.' });
    }
    next(error);
  } finally {
    connection?.release();
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const [rows] = await pool.execute(
      `SELECT u.id, u.role, u.linked_id, u.login_id, u.password_hash,
              COALESCE(a.name, f.name, d.hod_name, s.name, 'College User') AS display_name,
              f.department_id
       FROM Users u
       LEFT JOIN Admin a ON u.role = 'admin' AND a.id = u.linked_id
       LEFT JOIN Faculty f ON u.role = 'faculty' AND f.id = u.linked_id
       LEFT JOIN Departments d ON u.role = 'hod' AND d.id = u.linked_id
       LEFT JOIN Students s ON u.role = 'student' AND s.id = u.linked_id
       WHERE u.login_id = ? AND u.role = ? AND u.active = TRUE`,
      [input.loginId, input.role],
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(input.password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid login ID, password, or portal.' });
    }
    const token = jwt.sign(
      { id: user.id, role: user.role, linkedId: user.linked_id, departmentId: user.department_id },
      process.env.JWT_SECRET,
      { expiresIn: '8h' },
    );
    res.json({
      token,
      user: { role: user.role, name: user.display_name, loginId: user.login_id },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  res.json({ user: { role: req.user.role, loginId: req.user.loginId, linkedId: req.user.linkedId } });
});

app.get('/api/dashboard', authenticate, async (req, res, next) => {
  if (!['admin', 'faculty', 'hod'].includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have permission to view this dashboard.' });
  }
  try {
    const departmentScoped = ['hod', 'faculty'].includes(req.user.role);
    const departmentId = req.user.role === 'hod' ? req.user.linkedId : req.user.departmentId;
    const attendanceScope = req.user.role === 'faculty'
      ? ' AND a.faculty_id = ?'
      : req.user.role === 'hod' ? ' AND c.department_id = ?' : '';
    const summaryParams = [];
    if (departmentScoped) summaryParams.push(departmentId);
    if (departmentScoped) summaryParams.push(departmentId);
    if (req.user.role === 'faculty') summaryParams.push(req.user.linkedId);
    if (req.user.role === 'hod') summaryParams.push(departmentId);
    const [counts] = await pool.execute(
      `SELECT
        (SELECT COUNT(*) FROM Students s JOIN Classes c ON c.id=s.class_id WHERE s.active=TRUE${departmentScoped ? ' AND c.department_id=?' : ''}) AS students,
        (SELECT COUNT(*) FROM Faculty f WHERE f.active=TRUE${departmentScoped ? ' AND f.department_id=?' : ''}) AS faculty,
        COUNT(a.id) AS totalToday,
        SUM(a.status='present') AS present,
        SUM(a.status='absent') AS absent
       FROM Attendance a JOIN Classes c ON c.id=a.class_id
       WHERE a.attendance_date = CURDATE()${attendanceScope}`,
      summaryParams,
    );
    const [periods] = await pool.execute(
      `SELECT p.period_number AS period,
        COUNT(a.id) AS total,
        SUM(a.status='present') AS present,
        SUM(a.status='absent') AS absent
       FROM Periods p
       LEFT JOIN Attendance a ON a.period_id=p.id AND a.attendance_date=CURDATE()
         AND (? <> 'faculty' OR a.faculty_id=?)
         AND (? <> 'hod' OR EXISTS (
           SELECT 1 FROM Classes scoped_class
           WHERE scoped_class.id=a.class_id AND scoped_class.department_id=?
         ))
       GROUP BY p.id ORDER BY p.period_number`,
      [req.user.role, req.user.linkedId || -1, req.user.role, req.user.linkedId || -1],
    );
    const recentScope = req.user.role === 'faculty'
      ? 'AND a.faculty_id=?'
      : req.user.role === 'hod' ? 'AND cl.department_id=?' : '';
    const recentParams = req.user.role === 'faculty'
      ? [req.user.linkedId]
      : req.user.role === 'hod' ? [departmentId] : [];
    const [recentAbsences] = await pool.execute(
      `SELECT s.name AS student, s.register_number AS registerNumber, d.name AS department,
              cl.year, cl.section, p.period_number AS period, sub.name AS subject,
              f.name AS faculty, a.attendance_date AS date, a.id
       FROM Attendance a
       JOIN Students s ON s.id=a.student_id
       JOIN Classes cl ON cl.id=a.class_id
       JOIN Departments d ON d.id=cl.department_id
       JOIN Periods p ON p.id=a.period_id
       JOIN Subjects sub ON sub.id=a.subject_id
       JOIN Faculty f ON f.id=a.faculty_id
       WHERE a.status='absent' AND a.attendance_date=CURDATE()
       ${recentScope}
       ORDER BY a.submitted_at DESC LIMIT 8`,
      recentParams,
    );
    const departmentScope = departmentScoped ? 'WHERE d.id=?' : '';
    const [departmentAttendance] = await pool.execute(
      `SELECT d.id, d.name AS department, COUNT(a.id) AS total,
              SUM(a.status='present') AS present, SUM(a.status='absent') AS absent
       FROM Departments d
       LEFT JOIN Classes c ON c.department_id=d.id
       LEFT JOIN Attendance a ON a.class_id=c.id AND a.attendance_date=CURDATE()
       ${departmentScope}
       GROUP BY d.id ORDER BY d.name`,
      departmentScoped ? [departmentId] : [],
    );
    const frequentScope = req.user.role === 'faculty'
      ? 'AND a.faculty_id=?'
      : req.user.role === 'hod' ? 'AND c.department_id=?' : '';
    const [frequentAbsences] = await pool.execute(
      `SELECT s.name AS student, s.register_number AS registerNumber, d.name AS department,
              c.year, c.section, COUNT(a.id) AS absences
       FROM Attendance a JOIN Students s ON s.id=a.student_id
       JOIN Classes c ON c.id=a.class_id JOIN Departments d ON d.id=c.department_id
       WHERE a.status='absent' AND a.attendance_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       ${frequentScope}
       GROUP BY s.id, s.name, s.register_number, d.name, c.year, c.section
       HAVING COUNT(a.id) >= 3
       ORDER BY absences DESC, s.name LIMIT 6`,
      req.user.role === 'faculty' ? [req.user.linkedId]
        : req.user.role === 'hod' ? [departmentId] : [],
    );
    res.json({ summary: counts[0], periods, recentAbsences, departmentAttendance, frequentAbsences });
  } catch (error) {
    next(error);
  }
});

app.get('/api/student/attendance', authenticate, allowRoles('student'), async (req, res, next) => {
  try {
    const [[student]] = await pool.execute(
      `SELECT s.name, s.register_number AS registerNumber, s.roll_number AS rollNumber,
              c.year, c.section, c.academic_year AS academicYear, d.name AS department
       FROM Students s JOIN Classes c ON c.id=s.class_id
       JOIN Departments d ON d.id=c.department_id
       WHERE s.id=? AND s.active=TRUE`,
      [req.user.linkedId],
    );
    if (!student) return res.status(404).json({ error: 'Student profile not found.' });
    const [records] = await pool.execute(
      `SELECT a.attendance_date AS date, a.status, a.period_id AS periodId,
              p.period_number AS period, s.name AS subject
       FROM Attendance a JOIN Subjects s ON s.id=a.subject_id
       JOIN Periods p ON p.id=a.period_id
       WHERE a.student_id=?
       ORDER BY a.attendance_date DESC, p.period_number DESC
       LIMIT 100`,
      [req.user.linkedId],
    );
    const [[summary]] = await pool.execute(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status='present'), 0) AS present
       FROM Attendance WHERE student_id=?`,
      [req.user.linkedId],
    );
    res.json({ student, records, summary });
  } catch (error) {
    next(error);
  }
});

app.get('/api/classes', authenticate, allowRoles('admin', 'faculty', 'hod'), async (req, res, next) => {
  try {
    const [classes] = await pool.execute(
      `SELECT c.id, c.year, c.section, c.academic_year, d.id AS department_id,
              d.name AS department
       FROM Classes c JOIN Departments d ON d.id=c.department_id
       ${req.user.role === 'faculty' ? 'JOIN Timetable t ON t.class_id=c.id AND t.faculty_id=? AND t.active=TRUE' : ''}
       WHERE (? = 'admin' OR d.id = COALESCE(?, d.id))
       GROUP BY c.id ORDER BY d.name, c.year, c.section`,
      [req.user.role === 'faculty' ? req.user.linkedId : -1, req.user.role, req.user.departmentId || req.user.linkedId || null],
    );
    res.json({ classes });
  } catch (error) {
    next(error);
  }
});

app.get('/api/faculty', authenticate, allowRoles('admin', 'faculty', 'hod'), async (req, res, next) => {
  try {
    const [faculty] = await pool.execute(
      `SELECT id, name, 'Faculty' AS role
       FROM Faculty
       WHERE active=TRUE
       ORDER BY name`,
    );
    res.json({ faculty });
  } catch (error) {
    next(error);
  }
});

app.get('/api/periods', authenticate, allowRoles('admin', 'faculty', 'hod'), async (req, res, next) => {
  try {
    const [periods] = await pool.execute(
      'SELECT id, period_number, start_time, end_time FROM Periods ORDER BY period_number',
    );
    res.json({ periods });
  } catch (error) {
    next(error);
  }
});

app.get('/api/assignments', authenticate, allowRoles('admin', 'faculty', 'hod'), async (req, res, next) => {
  try {
    const classId = z.coerce.number().int().positive().parse(req.query.classId);
    const [assignments] = await pool.execute(
      `SELECT t.period_id, p.period_number, p.start_time, p.end_time,
              t.subject_id, s.name AS subject, t.faculty_id, f.name AS faculty
       FROM Timetable t
       JOIN Periods p ON p.id=t.period_id
       JOIN Subjects s ON s.id=t.subject_id
       JOIN Faculty f ON f.id=t.faculty_id
       WHERE t.class_id=? AND t.active=TRUE
         AND (? <> 'faculty' OR t.faculty_id=?)
         AND (? <> 'hod' OR EXISTS (
           SELECT 1 FROM Classes c WHERE c.id=t.class_id AND c.department_id=?
         ))
          AND t.day_of_week = WEEKDAY(?) + 1
        ORDER BY p.period_number`,
       [classId, req.user.role, req.user.linkedId || -1, req.user.role, req.user.linkedId || -1,
         req.query.date ? z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.date) : new Date().toLocaleDateString('en-CA')],
    );
    res.json({ assignments });
  } catch (error) {
    next(error);
  }
});

app.get('/api/students', authenticate, allowRoles('admin', 'faculty', 'hod'), async (req, res, next) => {
  try {
    const classId = z.coerce.number().int().positive().parse(req.query.classId);
    const [students] = await pool.execute(
      `SELECT id, name, register_number, roll_number
       FROM Students s WHERE class_id=? AND active=TRUE
         AND (? <> 'faculty' OR EXISTS (
           SELECT 1 FROM Timetable t WHERE t.class_id=s.class_id
             AND t.faculty_id=? AND t.active=TRUE
         ))
         AND (? <> 'hod' OR EXISTS (
           SELECT 1 FROM Classes c WHERE c.id=s.class_id AND c.department_id=?
         ))
       ORDER BY roll_number`,
      [classId, req.user.role, req.user.linkedId || -1, req.user.role, req.user.linkedId || -1],
    );
    res.json({ students });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/setup', authenticate, allowRoles('admin', 'hod'), async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const scope = [isAdmin ? 'admin' : 'hod', req.user.linkedId || -1];
    const [departments] = await pool.execute(
      `SELECT id, name, code, hod_name FROM Departments
       WHERE (? = 'admin' OR id = ?) ORDER BY name`,
      scope,
    );
    const [classes] = await pool.query(
      `SELECT c.id, c.department_id AS departmentId, c.year, c.section, c.academic_year AS academicYear,
              d.name AS department
       FROM Classes c JOIN Departments d ON d.id=c.department_id
       WHERE (? = 'admin' OR d.id = ?) ORDER BY d.name, c.year, c.section`,
      scope,
    );
    const [students] = await pool.query(
      `SELECT s.id, s.name, s.register_number AS registerNumber, s.roll_number AS rollNumber,
              s.class_id AS classId, s.parent_name AS parentName, s.parent_whatsapp AS parentWhatsApp,
              s.parent_whatsapp_consent AS parentWhatsAppConsent,
              s.photo_url AS photoUrl, s.email, c.year, c.section, d.name AS department, d.id AS departmentId
       FROM Students s JOIN Classes c ON c.id=s.class_id
       JOIN Departments d ON d.id=c.department_id
       WHERE s.active=TRUE AND (? = 'admin' OR d.id = ?)
       ORDER BY d.name, c.year, c.section, s.roll_number`,
      scope,
    );
    const [faculty] = await pool.query(
      `SELECT f.id, f.faculty_code AS facultyCode, f.name, f.email, f.department_id AS departmentId,
              d.name AS department FROM Faculty f JOIN Departments d ON d.id=f.department_id
       WHERE f.active=TRUE AND (? = 'admin' OR d.id = ?) ORDER BY f.name`,
      scope,
    );
    const [hods] = isAdmin ? await pool.query(
      `SELECT u.linked_id AS id, COALESCE(h.name, d.hod_name) AS name,
              h.email, h.whatsapp_number AS whatsappNumber, u.login_id AS loginId,
              d.name AS department
       FROM Users u JOIN Departments d ON d.id=u.linked_id
       LEFT JOIN HOD_Contacts h ON h.department_id=d.id
       WHERE u.role='hod' AND u.active=TRUE ORDER BY d.name`,
    ) : [[]];
    const [subjects] = await pool.query(
      `SELECT s.id, s.subject_code AS subjectCode, s.name, s.department_id AS departmentId,
              d.name AS department FROM Subjects s JOIN Departments d ON d.id=s.department_id
       WHERE (? = 'admin' OR d.id = ?) ORDER BY d.name, s.name`,
      scope,
    );
    const [periods] = await pool.query(
      `SELECT id, period_number AS periodNumber, start_time AS startTime, end_time AS endTime,
              submission_deadline_minutes AS submissionDeadlineMinutes FROM Periods ORDER BY period_number`,
    );
    const [assignments] = await pool.query(
      `SELECT t.id, t.class_id AS classId, t.faculty_id AS facultyId, t.subject_id AS subjectId,
              t.period_id AS periodId, t.day_of_week AS dayOfWeek, c.year, c.section,
              d.name AS department, f.name AS faculty, s.name AS subject, p.period_number AS period
       FROM Timetable t JOIN Classes c ON c.id=t.class_id
       JOIN Departments d ON d.id=c.department_id JOIN Faculty f ON f.id=t.faculty_id
       JOIN Subjects s ON s.id=t.subject_id JOIN Periods p ON p.id=t.period_id
       WHERE t.active=TRUE AND (? = 'admin' OR d.id = ?)
       ORDER BY d.name, c.year, p.period_number`,
      scope,
    );
    res.json({ departments, classes, students, faculty, hods, subjects, periods, assignments });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/registrations', authenticate, allowRoles('admin'), async (req, res, next) => {
  try {
    const [requests] = await pool.query(
      `SELECT r.id, r.role, r.login_id AS loginId, r.profile, r.created_at AS createdAt,
              d.name AS department, c.year, c.section
       FROM Registration_Requests r
       LEFT JOIN Departments d
         ON d.id=CAST(JSON_UNQUOTE(JSON_EXTRACT(r.profile, '$.departmentId')) AS UNSIGNED)
       LEFT JOIN Classes c
         ON c.id=CAST(JSON_UNQUOTE(JSON_EXTRACT(r.profile, '$.classId')) AS UNSIGNED)
       WHERE r.status='pending'
       ORDER BY r.created_at`,
    );
    res.json({
      requests: requests.map((request) => ({
        ...request,
        profile: typeof request.profile === 'string' ? JSON.parse(request.profile) : request.profile,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/admin/registrations/:id', authenticate, allowRoles('admin'), async (req, res, next) => {
  let connection;
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const input = z.object({ decision: z.enum(['approve', 'reject']) }).parse(req.body);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [[request]] = await connection.execute(
      `SELECT id, role, login_id, password_hash, profile
       FROM Registration_Requests WHERE id=? AND status='pending' FOR UPDATE`,
      [id],
    );
    if (!request) {
      await connection.rollback();
      return res.status(404).json({ error: 'This registration request is no longer pending.' });
    }
    if (!request.password_hash) {
      await connection.rollback();
      return res.status(409).json({ error: 'This older request cannot be approved because it has no saved password. Ask the applicant to submit a new registration.' });
    }
    if (input.decision === 'reject') {
      await connection.execute(
        `UPDATE Registration_Requests SET status='rejected', password_hash='' WHERE id=?`,
        [id],
      );
      await connection.commit();
      return res.json({ message: 'Registration request rejected.' });
    }
    const profile = typeof request.profile === 'string' ? JSON.parse(request.profile) : request.profile;
    let linkedId;
    if (request.role === 'faculty') {
      const [result] = await connection.execute(
        `INSERT INTO Faculty (faculty_code, name, email, department_id)
         VALUES (?, ?, ?, ?)`,
        [profile.facultyCode, profile.name, profile.email, profile.departmentId],
      );
      linkedId = result.insertId;
    } else if (request.role === 'student') {
      const [result] = await connection.execute(
        `INSERT INTO Students
           (name, register_number, roll_number, class_id, email, parent_name, parent_whatsapp, parent_whatsapp_consent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [profile.name, profile.registerNumber, profile.rollNumber, profile.classId, profile.email,
          profile.parentName || null, profile.parentWhatsApp || null, profile.parentWhatsAppConsent === true],
      );
      linkedId = result.insertId;
      if (profile.parentWhatsApp) {
        await connection.execute(
          `INSERT INTO Parent_Contacts (student_id, parent_name, whatsapp_number)
           VALUES (?, ?, ?)`,
          [linkedId, profile.parentName || null, profile.parentWhatsApp],
        );
      }
    } else {
      const [[existingHod]] = await connection.execute(
        `SELECT id FROM Users WHERE role='hod' AND linked_id=? AND active=TRUE FOR UPDATE`,
        [profile.departmentId],
      );
      if (existingHod) {
        await connection.rollback();
        return res.status(409).json({ error: 'An active HOD account already exists for this department.' });
      }
      linkedId = profile.departmentId;
      await connection.execute(
        'UPDATE Departments SET hod_name=? WHERE id=?',
        [profile.name, profile.departmentId],
      );
      await connection.execute(
        `INSERT INTO HOD_Contacts (department_id, name, email, whatsapp_number) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), email=VALUES(email), whatsapp_number=VALUES(whatsapp_number)`,
        [profile.departmentId, profile.name, profile.email || null, profile.whatsappNumber],
      );
    }
    await connection.execute(
      `INSERT INTO Users (role, linked_id, login_id, password_hash)
       VALUES (?, ?, ?, ?)`,
      [request.role, linkedId, request.login_id, request.password_hash],
    );
    await connection.execute(
      `UPDATE Registration_Requests SET status='approved', password_hash='' WHERE id=?`,
      [id],
    );
    await connection.commit();
    res.json({ message: 'Registration request approved.' });
  } catch (error) {
    if (connection) await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'This profile or login ID is already registered. Review the request details before approving.' });
    }
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ error: 'The selected department or class no longer exists. Ask the applicant to submit a new request.' });
    }
    if (['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'WARN_DATA_TRUNCATED'].includes(error.code)) {
      console.error('Registration approval failed because the database schema is incomplete. Run database/schema.sql.');
      return res.status(503).json({ error: 'Approval is temporarily unavailable because the database schema is incomplete. Contact the administrator.' });
    }
    next(error);
  } finally {
    connection?.release();
  }
});

const setupSchemas = {
  department: z.object({ type: z.literal('department'), name: z.string().trim().min(2).max(120), code: z.string().trim().min(2).max(20).transform((value) => value.toUpperCase()), hodName: z.string().trim().max(120).optional().default('') }),
  class: z.object({ type: z.literal('class'), departmentId: z.number().int().positive(), year: z.number().int().min(1).max(6), section: z.string().trim().min(1).max(10), academicYear: z.string().trim().min(4).max(20) }),
  student: z.object({ type: z.literal('student'), id: z.number().int().positive().optional(), name: z.string().trim().min(2).max(120), registerNumber: z.string().trim().min(1).max(40), rollNumber: z.string().trim().min(1).max(30), classId: z.number().int().positive(), parentName: z.string().trim().max(120).optional().default(''), parentWhatsApp: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/).or(z.literal('')).optional().default(''), parentWhatsAppConsent: z.boolean().optional().default(false), photoUrl: z.string().trim().max(500).optional().default(''), email: z.string().trim().email().max(190).or(z.literal('')).optional().default('') }).refine((value) => !value.parentWhatsAppConsent || Boolean(value.parentWhatsApp), { message: 'A parent WhatsApp number is required to record consent.', path: ['parentWhatsAppConsent'] }),
  faculty: z.object({ type: z.literal('faculty'), facultyCode: z.string().trim().min(1).max(40), name: z.string().trim().min(2).max(120), email: z.string().trim().email().max(190), departmentId: z.number().int().positive(), password: z.string().min(12).max(72).refine((value) => Buffer.byteLength(value) <= 72) }),
  hod: z.object({ type: z.literal('hod'), name: z.string().trim().min(2).max(120), loginId: z.string().trim().min(1).max(190), email: z.string().trim().email().max(190).or(z.literal('')).optional().default(''), departmentId: z.number().int().positive(), whatsappNumber: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/), password: z.string().min(12).max(72).refine((value) => Buffer.byteLength(value) <= 72) }),
  subject: z.object({ type: z.literal('subject'), subjectCode: z.string().trim().min(1).max(30), name: z.string().trim().min(2).max(120), departmentId: z.number().int().positive() }),
  period: z.object({ type: z.literal('period'), periodNumber: z.number().int().min(1).max(20), startTime: z.string().regex(/^\d{2}:\d{2}$/), endTime: z.string().regex(/^\d{2}:\d{2}$/), submissionDeadlineMinutes: z.number().int().min(0).max(1440) }),
  assignment: z.object({ type: z.literal('assignment'), classId: z.number().int().positive(), subjectId: z.number().int().positive(), facultyId: z.number().int().positive(), periodId: z.number().int().positive(), dayOfWeek: z.number().int().min(1).max(7) }),
};

app.post('/api/admin/setup', authenticate, allowRoles('admin', 'hod'), async (req, res, next) => {
  let connection;
  try {
    const schema = setupSchemas[req.body?.type];
    if (!schema) return res.status(400).json({ error: 'Choose a supported setup record type.' });
    if (req.user.role !== 'admin' && req.body?.type !== 'assignment') {
      return res.status(403).json({ error: 'Only administrators can create this type of record.' });
    }
    const input = schema.parse(req.body);
    if (input.type === 'department') {
      await pool.execute('INSERT INTO Departments (name, code, hod_name) VALUES (?, ?, ?)', [input.name, input.code, input.hodName || null]);
    } else if (input.type === 'class') {
      await pool.execute('INSERT INTO Classes (department_id, year, section, academic_year) VALUES (?, ?, ?, ?)', [input.departmentId, input.year, input.section, input.academicYear]);
    } else if (input.type === 'student') {
      if (input.id) {
        await pool.execute(
          `UPDATE Students SET name=?, register_number=?, roll_number=?, class_id=?,
             parent_name=?, parent_whatsapp=?, parent_whatsapp_consent=?, photo_url=?, email=? WHERE id=? AND active=TRUE`,
          [input.name, input.registerNumber, input.rollNumber, input.classId, input.parentName || null,
            input.parentWhatsApp || null, input.parentWhatsAppConsent, input.photoUrl || null, input.email || null, input.id],
        );
      } else {
        await pool.execute(
          `INSERT INTO Students (name, register_number, roll_number, class_id, parent_name, parent_whatsapp, parent_whatsapp_consent, photo_url, email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [input.name, input.registerNumber, input.rollNumber, input.classId, input.parentName || null,
            input.parentWhatsApp || null, input.parentWhatsAppConsent, input.photoUrl || null, input.email || null],
        );
      }
      if (input.parentWhatsApp) {
        const [[student]] = await pool.execute('SELECT id FROM Students WHERE register_number=?', [input.registerNumber]);
        await pool.execute(
          `INSERT INTO Parent_Contacts (student_id, parent_name, whatsapp_number) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE parent_name=VALUES(parent_name), whatsapp_number=VALUES(whatsapp_number)`,
          [student.id, input.parentName || null, input.parentWhatsApp],
        );
      }
    } else if (input.type === 'faculty') {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const passwordHash = await bcrypt.hash(input.password, 12);
      const [result] = await connection.execute(
        'INSERT INTO Faculty (faculty_code, name, email, department_id) VALUES (?, ?, ?, ?)',
        [input.facultyCode, input.name, input.email, input.departmentId],
      );
      await connection.execute(
        `INSERT INTO Users (role, linked_id, login_id, password_hash) VALUES ('faculty', ?, ?, ?)`,
        [result.insertId, input.facultyCode, passwordHash],
      );
      await connection.commit();
    } else if (input.type === 'hod') {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const passwordHash = await bcrypt.hash(input.password, 12);
      await connection.execute(
        `UPDATE Departments SET hod_name=? WHERE id=?`,
        [input.name, input.departmentId],
      );
      await connection.execute(
        `INSERT INTO HOD_Contacts (department_id, name, email, whatsapp_number) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), email=VALUES(email), whatsapp_number=VALUES(whatsapp_number)`,
        [input.departmentId, input.name, input.email || null, input.whatsappNumber],
      );
      await connection.execute(
        `INSERT INTO Users (role, linked_id, login_id, password_hash) VALUES ('hod', ?, ?, ?)
         ON DUPLICATE KEY UPDATE linked_id=VALUES(linked_id), password_hash=VALUES(password_hash), active=TRUE`,
        [input.departmentId, input.loginId, passwordHash],
      );
      await connection.commit();
    } else if (input.type === 'subject') {
      await pool.execute('INSERT INTO Subjects (department_id, subject_code, name) VALUES (?, ?, ?)', [input.departmentId, input.subjectCode, input.name]);
    } else if (input.type === 'period') {
      await pool.execute(
        `INSERT INTO Periods (period_number, start_time, end_time, submission_deadline_minutes)
         VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE start_time=VALUES(start_time), end_time=VALUES(end_time), submission_deadline_minutes=VALUES(submission_deadline_minutes)`,
        [input.periodNumber, input.startTime, input.endTime, input.submissionDeadlineMinutes],
      );
    } else if (input.type === 'assignment') {
      const [[assignmentRecords]] = await pool.execute(
        `SELECT c.department_id AS classDepartmentId, s.department_id AS subjectDepartmentId,
                f.department_id AS facultyDepartmentId
         FROM Classes c
         JOIN Subjects s ON s.id=?
         JOIN Faculty f ON f.id=? AND f.active=TRUE
         WHERE c.id=?`,
        [input.subjectId, input.facultyId, input.classId],
      );
      if (!assignmentRecords
        || assignmentRecords.classDepartmentId !== assignmentRecords.subjectDepartmentId
        || assignmentRecords.classDepartmentId !== assignmentRecords.facultyDepartmentId) {
        return res.status(400).json({ error: 'Choose a class, subject, and active faculty member from the same department.' });
      }
      if (req.user.role === 'hod' && assignmentRecords.classDepartmentId !== req.user.linkedId) {
        return res.status(403).json({ error: 'You can only assign periods within your department.' });
      }
      await pool.execute(
        `INSERT INTO Timetable (class_id, subject_id, faculty_id, period_id, day_of_week)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE subject_id=VALUES(subject_id), faculty_id=VALUES(faculty_id), active=TRUE`,
        [input.classId, input.subjectId, input.facultyId, input.periodId, input.dayOfWeek],
      );
    }
    res.status(201).json({ message: 'Record saved successfully.' });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    connection?.release();
  }
});

app.delete('/api/management/:type/:id', authenticate, allowRoles('admin', 'hod'), async (req, res, next) => {
  let connection;
  try {
    const type = z.enum(['department', 'class', 'faculty', 'student', 'hod']).parse(req.params.type);
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const isAdmin = req.user.role === 'admin';
    if (type === 'hod' && !isAdmin) {
      return res.status(403).json({ error: 'Only an administrator can delete an HOD account.' });
    }
    connection = await pool.getConnection();
    await connection.beginTransaction();

    if (type === 'hod') {
      const [[hod]] = await connection.execute(
        `SELECT u.linked_id FROM Users u
         WHERE u.role='hod' AND u.linked_id=? AND u.active=TRUE FOR UPDATE`,
        [id],
      );
      if (!hod) {
        await connection.rollback();
        return res.status(404).json({ error: 'Active HOD account not found.' });
      }
      await connection.execute("UPDATE Users SET active=FALSE WHERE role='hod' AND linked_id=?", [id]);
      await connection.execute('DELETE FROM HOD_Contacts WHERE department_id=?', [id]);
      await connection.execute('UPDATE Departments SET hod_name=NULL WHERE id=?', [id]);
    } else if (type === 'student') {
      const [[student]] = await connection.execute(
        `SELECT s.id FROM Students s JOIN Classes c ON c.id=s.class_id
         WHERE s.id=? AND s.active=TRUE AND (? = 'admin' OR c.department_id=?) FOR UPDATE`,
        [id, isAdmin ? 'admin' : 'hod', req.user.linkedId || -1],
      );
      if (!student) {
        await connection.rollback();
        return res.status(404).json({ error: 'Active student not found in your department.' });
      }
      await connection.execute('UPDATE Students SET active=FALSE WHERE id=?', [id]);
      await connection.execute("UPDATE Users SET active=FALSE WHERE role='student' AND linked_id=?", [id]);
    } else if (type === 'faculty') {
      const [[faculty]] = await connection.execute(
        `SELECT id FROM Faculty WHERE id=? AND active=TRUE
         AND (? = 'admin' OR department_id=?) FOR UPDATE`,
        [id, isAdmin ? 'admin' : 'hod', req.user.linkedId || -1],
      );
      if (!faculty) {
        await connection.rollback();
        return res.status(404).json({ error: 'Active faculty member not found in your department.' });
      }
      await connection.execute('UPDATE Faculty SET active=FALSE WHERE id=?', [id]);
      await connection.execute("UPDATE Users SET active=FALSE WHERE role='faculty' AND linked_id=?", [id]);
      await connection.execute('UPDATE Timetable SET active=FALSE WHERE faculty_id=?', [id]);
    } else if (type === 'class') {
      const [[classRecord]] = await connection.execute(
        `SELECT id FROM Classes WHERE id=?
         AND (? = 'admin' OR department_id=?) FOR UPDATE`,
        [id, isAdmin ? 'admin' : 'hod', req.user.linkedId || -1],
      );
      if (!classRecord) {
        await connection.rollback();
        return res.status(404).json({ error: 'Class not found in your department.' });
      }
      const [[references]] = await connection.execute(
        `SELECT
           (SELECT COUNT(*) FROM Students WHERE class_id=?) AS students,
           (SELECT COUNT(*) FROM Timetable WHERE class_id=?) AS assignments,
           (SELECT COUNT(*) FROM Attendance WHERE class_id=?) AS attendance`,
        [id, id, id],
      );
      if (references.students || references.assignments || references.attendance) {
        await connection.rollback();
        return res.status(409).json({ error: 'This class cannot be deleted while students, timetable assignments, or attendance history reference it.' });
      }
      await connection.execute('DELETE FROM Classes WHERE id=?', [id]);
    } else {
      const [[department]] = await connection.execute(
        `SELECT id FROM Departments WHERE id=? AND (? = 'admin' OR id=?) FOR UPDATE`,
        [id, isAdmin ? 'admin' : 'hod', req.user.linkedId || -1],
      );
      if (!department) {
        await connection.rollback();
        return res.status(404).json({ error: 'Department not found or outside your department.' });
      }
      const [[references]] = await connection.execute(
        `SELECT
           (SELECT COUNT(*) FROM Classes WHERE department_id=?) AS classes,
           (SELECT COUNT(*) FROM Faculty WHERE department_id=?) AS faculty,
           (SELECT COUNT(*) FROM Subjects WHERE department_id=?) AS subjects`,
        [id, id, id],
      );
      if (references.classes || references.faculty || references.subjects) {
        await connection.rollback();
        return res.status(409).json({ error: 'This department cannot be deleted while classes, faculty, or subjects reference it.' });
      }
      await connection.execute("UPDATE Users SET active=FALSE WHERE role='hod' AND linked_id=?", [id]);
      await connection.execute('DELETE FROM Departments WHERE id=?', [id]);
    }

    await connection.commit();
    const labels = { department: 'Department', class: 'Class', faculty: 'Faculty member', student: 'Student', hod: 'HOD account' };
    res.json({ message: `${labels[type]} deleted successfully.` });
  } catch (error) {
    if (connection) await connection.rollback();
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This record cannot be deleted while other records depend on it.' });
    }
    next(error);
  } finally {
    connection?.release();
  }
});

const attendanceSchema = z.object({
  classId: z.number().int().positive(),
  subjectId: z.number().int().positive(),
  periodId: z.number().int().positive(),
  attendanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  records: z.array(z.object({
    studentId: z.number().int().positive(),
    status: z.enum(['present', 'absent']),
  })).min(1).max(300),
});

app.post('/api/attendance', authenticate, allowRoles('admin', 'faculty'), async (req, res, next) => {
  let connection;
  try {
    const input = attendanceSchema.parse(req.body);
    const studentIds = input.records.map((record) => record.studentId);
    if (new Set(studentIds).size !== studentIds.length) {
      return res.status(400).json({ error: 'Each student can appear only once in a submission.' });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [slots] = await connection.execute(
      `SELECT t.faculty_id, t.subject_id, p.period_number, p.end_time,
              f.name AS faculty, s.name AS subject
       FROM Timetable t
       JOIN Periods p ON p.id=t.period_id
       JOIN Faculty f ON f.id=t.faculty_id
       JOIN Subjects s ON s.id=t.subject_id
       WHERE t.class_id=? AND t.period_id=? AND t.subject_id=? AND t.active=TRUE
         AND (? = 'admin' OR t.faculty_id=?)
         AND t.day_of_week = WEEKDAY(?) + 1 LIMIT 1`,
      [input.classId, input.periodId, input.subjectId, req.user.role, req.user.linkedId || -1, input.attendanceDate],
    );
    const slot = slots[0];
    if (!slot) {
      await connection.rollback();
      return res.status(403).json({ error: 'This class, subject, and period are not assigned to your account.' });
    }

    const [classRows] = await connection.execute(
      `SELECT s.id, s.class_id, s.name, s.register_number, s.parent_whatsapp,
              s.parent_whatsapp_consent, c.year, c.section, d.name AS department
       FROM Students s JOIN Classes c ON c.id=s.class_id
       JOIN Departments d ON d.id=c.department_id
       WHERE s.class_id=? AND s.active=TRUE`,
      [input.classId],
    );
    const studentMap = new Map(classRows.map((student) => [student.id, student]));
    if (studentIds.some((id) => !studentMap.has(id))) {
      await connection.rollback();
      return res.status(400).json({ error: 'Submission includes a student outside the selected class.' });
    }

    const notificationIds = [];
    let updated = 0;
    for (const record of input.records) {
      const [[existing]] = await connection.execute(
        `SELECT id, status FROM Attendance
         WHERE student_id=? AND subject_id=? AND attendance_date=? AND period_id=? FOR UPDATE`,
        [record.studentId, input.subjectId, input.attendanceDate, input.periodId],
      );
      if (existing) {
        const [periodRows] = await connection.execute(
          'SELECT submission_deadline_minutes FROM Periods WHERE id=?',
          [input.periodId],
        );
        const [hours, minutes] = String(slot.end_time).split(':').map(Number);
        const deadline = new Date(`${input.attendanceDate}T00:00:00`);
        deadline.setHours(hours, minutes + Number(periodRows[0].submission_deadline_minutes), 0, 0);
        if (Date.now() > deadline.getTime()) {
          await connection.rollback();
          return res.status(403).json({ error: 'The editing deadline for this period has passed.' });
        }
        await connection.execute(
          'UPDATE Attendance SET status=?, faculty_id=? WHERE id=?',
          [record.status, slot.faculty_id, existing.id],
        );
        updated += 1;
        if (existing.status !== record.status) {
          await connection.execute(
            `INSERT INTO Attendance_Corrections
              (attendance_id, previous_status, new_status, changed_by)
             VALUES (?, ?, ?, ?)`,
            [existing.id, existing.status, record.status, req.user.id],
          );
        }
        if (existing.status === 'absent' && record.status === 'present') {
          await connection.execute(
            `UPDATE WhatsApp_Notifications SET status='corrected',
               error_message='Attendance corrected from absent to present.'
             WHERE attendance_id=? AND status <> 'corrected'`,
            [existing.id],
          );
        }
        if (record.status === 'absent') {
          await createAbsenceNotifications(connection, existing.id, studentMap.get(record.studentId), {
            attendanceDate: input.attendanceDate,
          });
          const [pending] = await connection.execute(
            `SELECT id FROM WhatsApp_Notifications
             WHERE attendance_id=? AND recipient_type='parent' AND status='pending'`,
            [existing.id],
          );
          notificationIds.push(...pending.map((notification) => notification.id));
        }
      } else {
        const [insertResult] = await connection.execute(
          `INSERT INTO Attendance
            (student_id, faculty_id, subject_id, class_id, attendance_date, period_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [record.studentId, slot.faculty_id, input.subjectId, input.classId, input.attendanceDate, input.periodId, record.status],
        );
        if (record.status === 'absent') {
          await createAbsenceNotifications(connection, insertResult.insertId, studentMap.get(record.studentId), {
            attendanceDate: input.attendanceDate,
          });
          const [pending] = await connection.execute(
            `SELECT id FROM WhatsApp_Notifications
             WHERE attendance_id=? AND recipient_type='parent' AND status='pending'`,
            [insertResult.insertId],
          );
          notificationIds.push(...pending.map((notification) => notification.id));
        }
      }
    }
    await connection.commit();
    await Promise.all(notificationIds.map((id) => deliverNotification(id)));
    res.json({ message: 'Attendance saved successfully.', submitted: input.records.length, updated });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

app.get('/api/attendance', authenticate, allowRoles('admin', 'faculty', 'hod'), async (req, res, next) => {
  try {
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.date);
    const classId = z.coerce.number().int().positive().parse(req.query.classId);
    const periodId = z.coerce.number().int().positive().parse(req.query.periodId);
    const subjectId = z.coerce.number().int().positive().parse(req.query.subjectId);
    const [records] = await pool.execute(
      `SELECT student_id AS studentId, status FROM Attendance
       WHERE attendance_date=? AND class_id=? AND period_id=? AND subject_id=?
         AND (? <> 'faculty' OR faculty_id=?)
         AND (? <> 'hod' OR EXISTS (
           SELECT 1 FROM Classes c WHERE c.id=Attendance.class_id AND c.department_id=?
         ))`,
      [date, classId, periodId, subjectId, req.user.role, req.user.linkedId || -1,
        req.user.role, req.user.linkedId || -1],
    );
    res.json({ records });
  } catch (error) {
    next(error);
  }
});

app.get('/api/reports/attendance', authenticate, allowRoles('admin', 'faculty', 'hod'), async (req, res, next) => {
  try {
    const start = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.start);
    const end = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.end);
    const [rows] = await pool.execute(
      `SELECT a.attendance_date AS date, s.name AS student, s.register_number AS registerNumber,
              d.name AS department, c.year, c.section, p.period_number AS period,
              sub.name AS subject, f.name AS faculty, a.status
       FROM Attendance a JOIN Students s ON s.id=a.student_id
       JOIN Classes c ON c.id=a.class_id JOIN Departments d ON d.id=c.department_id
       JOIN Periods p ON p.id=a.period_id JOIN Subjects sub ON sub.id=a.subject_id
       JOIN Faculty f ON f.id=a.faculty_id
       WHERE a.attendance_date BETWEEN ? AND ?
       ${req.user.role === 'hod' ? 'AND c.department_id=?' : ''}
       ${req.user.role === 'faculty' ? 'AND a.faculty_id=?' : ''}
       ORDER BY a.attendance_date DESC, p.period_number, s.roll_number`,
      req.user.role === 'hod' ? [start, end, req.user.linkedId]
        : req.user.role === 'faculty' ? [start, end, req.user.linkedId] : [start, end],
    );
    res.json({ records: rows });
  } catch (error) {
    next(error);
  }
});

app.get('/api/notifications', authenticate, allowRoles('admin', 'faculty', 'hod'), async (req, res, next) => {
  try {
    const [notifications] = await pool.execute(
      `SELECT n.id, n.recipient_type AS recipientType, n.recipient_number AS recipientNumber,
              n.status, n.error_message AS errorMessage, n.attempts, n.created_at AS createdAt,
              s.name AS student, s.register_number AS registerNumber,
              a.attendance_date AS attendanceDate, p.period_number AS period
       FROM WhatsApp_Notifications n JOIN Attendance a ON a.id=n.attendance_id
       JOIN Students s ON s.id=a.student_id JOIN Periods p ON p.id=a.period_id
       JOIN Classes c ON c.id=a.class_id
       WHERE n.recipient_type='parent'
         AND (? <> 'hod' OR c.department_id=?)
         AND (? <> 'faculty' OR a.faculty_id=?)
       ORDER BY n.created_at DESC LIMIT 100`,
      [req.user.role, req.user.linkedId || -1, req.user.role, req.user.linkedId || -1],
    );
    const [summaryRows] = await pool.execute(
      `SELECT COUNT(*) AS total,
              SUM(n.status='pending' OR n.status='sending') AS pending,
              SUM(n.status='sent') AS sent,
              SUM(n.status='delivered') AS delivered,
              SUM(n.status='failed') AS failed
       FROM WhatsApp_Notifications n JOIN Attendance a ON a.id=n.attendance_id
       JOIN Classes c ON c.id=a.class_id
       WHERE n.recipient_type='parent'
         AND (? <> 'hod' OR c.department_id=?)
         AND (? <> 'faculty' OR a.faculty_id=?)`,
      [req.user.role, req.user.linkedId || -1, req.user.role, req.user.linkedId || -1],
    );
    res.json({ notifications, summary: summaryRows[0] });
  } catch (error) {
    next(error);
  }
});

app.post('/api/notifications/:id/retry', authenticate, allowRoles('admin', 'hod'), async (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const [result] = await pool.execute(
      `UPDATE WhatsApp_Notifications n JOIN Attendance a ON a.id=n.attendance_id
       JOIN Classes c ON c.id=a.class_id
       JOIN Students s ON s.id=a.student_id
       SET n.recipient_number=s.parent_whatsapp,
           n.status='pending', n.error_message=NULL
       WHERE n.id=? AND n.status='failed' AND n.recipient_type='parent'
         AND a.status='absent' AND s.parent_whatsapp_consent=TRUE
         AND s.parent_whatsapp IS NOT NULL AND s.parent_whatsapp <> ''
         AND (? <> 'hod' OR c.department_id=?)`,
      [id, req.user.role, req.user.linkedId || -1],
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Failed notification not found.' });
    await deliverNotification(id);
    res.json({ message: 'Notification retry completed.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/whatsapp/webhook', async (req, res, next) => {
  try {
    const signature = req.headers['x-hub-signature-256'];
    if (!process.env.META_APP_SECRET || typeof signature !== 'string' || !req.rawBody) {
      return res.sendStatus(401);
    }
    const expected = `sha256=${createHmac('sha256', process.env.META_APP_SECRET).update(req.rawBody).digest('hex')}`;
    const suppliedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
      return res.sendStatus(401);
    }
    const entries = req.body.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        for (const status of change.value?.statuses || []) {
          if (!['delivered', 'failed', 'read'].includes(status.status)) continue;
          await pool.execute(
            `UPDATE WhatsApp_Notifications SET status=?, error_message=?
             WHERE provider_message_id=? AND status IN ('sending', 'sent')`,
            [status.status === 'read' ? 'delivered' : status.status,
              status.errors?.[0]?.title || null, status.id],
          );
        }
      }
    }
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

app.get('/api/whatsapp/webhook', (req, res) => {
  if (req.query['hub.verify_token'] !== process.env.META_VERIFY_TOKEN) return res.sendStatus(403);
  res.status(200).send(req.query['hub.challenge']);
});

app.get('/api/health', async (req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(resolve(serverDirectory, '../dist')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(resolve(serverDirectory, '../dist/index.html'), (error) => {
    if (error) next();
  });
});

app.use((error, req, res, next) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message || 'Invalid request data.', details: error.issues });
  console.error(error);
  res.status(500).json({ error: 'The request could not be completed.' });
});

app.listen(port, () => console.log(`Smart Attendance API listening on http://localhost:${port}`));
