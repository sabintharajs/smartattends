import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pool from './db.js';

try {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || 'System Administrator';
  if (!email || !password || password === 'change-this-before-use' || password.length < 12 || Buffer.byteLength(password) > 72) {
    throw new Error('Set ADMIN_EMAIL and a unique ADMIN_PASSWORD (12–72 bytes) in .env before seeding.');
  }
  const hash = await bcrypt.hash(password, 12);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [adminResult] = await connection.execute(
      `INSERT INTO Admin (name, email, password_hash) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), password_hash=VALUES(password_hash)`,
      [name, email, hash],
    );
    const [[admin]] = await connection.execute('SELECT id FROM Admin WHERE email=?', [email]);
    await connection.execute(
      `INSERT INTO Users (role, linked_id, login_id, password_hash, active)
       VALUES ('admin', ?, ?, ?, TRUE)
       ON DUPLICATE KEY UPDATE linked_id=VALUES(linked_id), password_hash=VALUES(password_hash), active=TRUE`,
      [admin.id, email, hash],
    );
    await connection.commit();
    console.log(`Admin account ready for ${email}.`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
} finally {
  await pool.end();
}
