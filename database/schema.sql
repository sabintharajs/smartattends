CREATE DATABASE IF NOT EXISTS smart_attendance
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE smart_attendance;

CREATE TABLE IF NOT EXISTS Departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  code VARCHAR(20) NOT NULL UNIQUE,
  hod_name VARCHAR(120),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Classes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  department_id INT NOT NULL,
  year TINYINT UNSIGNED NOT NULL,
  section VARCHAR(10) NOT NULL,
  academic_year VARCHAR(20) NOT NULL,
  UNIQUE KEY uq_class (department_id, year, section, academic_year),
  FOREIGN KEY (department_id) REFERENCES Departments(id)
);

CREATE TABLE IF NOT EXISTS Admin (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Faculty (
  id INT AUTO_INCREMENT PRIMARY KEY,
  faculty_code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  department_id INT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES Departments(id)
);

CREATE TABLE IF NOT EXISTS Students (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  register_number VARCHAR(40) NOT NULL UNIQUE,
  roll_number VARCHAR(30) NOT NULL,
  class_id INT NOT NULL,
  parent_name VARCHAR(120),
  parent_whatsapp VARCHAR(24),
  parent_whatsapp_consent BOOLEAN NOT NULL DEFAULT FALSE,
  photo_url VARCHAR(500),
  email VARCHAR(190),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (class_id) REFERENCES Classes(id)
);

SET @parent_whatsapp_consent_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'Students'
    AND COLUMN_NAME = 'parent_whatsapp_consent'
);
SET @parent_whatsapp_consent_ddl = IF(
  @parent_whatsapp_consent_exists = 0,
  'ALTER TABLE Students ADD COLUMN parent_whatsapp_consent BOOLEAN NOT NULL DEFAULT FALSE AFTER parent_whatsapp',
  'SELECT 1'
);
PREPARE parent_whatsapp_consent_statement FROM @parent_whatsapp_consent_ddl;
EXECUTE parent_whatsapp_consent_statement;
DEALLOCATE PREPARE parent_whatsapp_consent_statement;

CREATE TABLE IF NOT EXISTS Parent_Contacts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL UNIQUE,
  parent_name VARCHAR(120),
  whatsapp_number VARCHAR(24) NOT NULL,
  FOREIGN KEY (student_id) REFERENCES Students(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS HOD_Contacts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  department_id INT NOT NULL,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190),
  whatsapp_number VARCHAR(24) NOT NULL,
  UNIQUE KEY uq_hod_department (department_id),
  FOREIGN KEY (department_id) REFERENCES Departments(id) ON DELETE CASCADE
);

SET @hod_email_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'HOD_Contacts'
    AND COLUMN_NAME = 'email'
);
SET @hod_email_ddl = IF(
  @hod_email_exists = 0,
  'ALTER TABLE HOD_Contacts ADD COLUMN email VARCHAR(190) NULL AFTER name',
  'SELECT 1'
);
PREPARE hod_email_statement FROM @hod_email_ddl;
EXECUTE hod_email_statement;
DEALLOCATE PREPARE hod_email_statement;

CREATE TABLE IF NOT EXISTS Subjects (
  id INT AUTO_INCREMENT PRIMARY KEY,
  department_id INT NOT NULL,
  subject_code VARCHAR(30) NOT NULL,
  name VARCHAR(120) NOT NULL,
  UNIQUE KEY uq_subject (department_id, subject_code),
  FOREIGN KEY (department_id) REFERENCES Departments(id)
);

CREATE TABLE IF NOT EXISTS Periods (
  id INT AUTO_INCREMENT PRIMARY KEY,
  period_number TINYINT UNSIGNED NOT NULL UNIQUE,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  submission_deadline_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 60
);

CREATE TABLE IF NOT EXISTS Timetable (
  id INT AUTO_INCREMENT PRIMARY KEY,
  class_id INT NOT NULL,
  subject_id INT NOT NULL,
  faculty_id INT NOT NULL,
  period_id INT NOT NULL,
  day_of_week TINYINT UNSIGNED NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE KEY uq_timetable_slot (class_id, period_id, day_of_week),
  FOREIGN KEY (class_id) REFERENCES Classes(id),
  FOREIGN KEY (subject_id) REFERENCES Subjects(id),
  FOREIGN KEY (faculty_id) REFERENCES Faculty(id),
  FOREIGN KEY (period_id) REFERENCES Periods(id)
);

CREATE TABLE IF NOT EXISTS Users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role ENUM('admin','faculty','hod','student') NOT NULL,
  linked_id INT NULL,
  login_id VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_linked (role, linked_id)
);

ALTER TABLE Users MODIFY role ENUM('admin','faculty','hod','student') NOT NULL;

CREATE TABLE IF NOT EXISTS Registration_Requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role ENUM('faculty','student','hod') NOT NULL,
  login_id VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NULL,
  profile JSON NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE Registration_Requests
  MODIFY login_id VARCHAR(190) NOT NULL;

SET @registration_password_hash_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'Registration_Requests'
    AND COLUMN_NAME = 'password_hash'
);
SET @registration_password_hash_ddl = IF(
  @registration_password_hash_exists = 0,
  'ALTER TABLE Registration_Requests ADD COLUMN password_hash VARCHAR(255) NULL AFTER login_id',
  'SELECT 1'
);
PREPARE registration_password_hash_statement FROM @registration_password_hash_ddl;
EXECUTE registration_password_hash_statement;
DEALLOCATE PREPARE registration_password_hash_statement;

CREATE TABLE IF NOT EXISTS Password_Reset_Tokens (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_password_reset_user (user_id, expires_at, used_at),
  FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Attendance (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL,
  faculty_id INT NOT NULL,
  subject_id INT NOT NULL,
  class_id INT NOT NULL,
  attendance_date DATE NOT NULL,
  period_id INT NOT NULL,
  status ENUM('present','absent') NOT NULL,
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_attendance (student_id, subject_id, attendance_date, period_id),
  INDEX idx_attendance_date_class (attendance_date, class_id),
  FOREIGN KEY (student_id) REFERENCES Students(id),
  FOREIGN KEY (faculty_id) REFERENCES Faculty(id),
  FOREIGN KEY (subject_id) REFERENCES Subjects(id),
  FOREIGN KEY (class_id) REFERENCES Classes(id),
  FOREIGN KEY (period_id) REFERENCES Periods(id)
);

CREATE TABLE IF NOT EXISTS Attendance_Corrections (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  attendance_id BIGINT NOT NULL,
  previous_status ENUM('present','absent') NOT NULL,
  new_status ENUM('present','absent') NOT NULL,
  changed_by INT NOT NULL,
  corrected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (attendance_id) REFERENCES Attendance(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES Users(id)
);

CREATE TABLE IF NOT EXISTS WhatsApp_Notifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  attendance_id BIGINT NOT NULL,
  cycle_number SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  recipient_type ENUM('parent','hod') NOT NULL,
  recipient_number VARCHAR(24) NOT NULL,
  message TEXT NOT NULL,
  status ENUM('pending','sending','sent','delivered','failed','corrected') NOT NULL DEFAULT 'pending',
  provider_message_id VARCHAR(160),
  error_message VARCHAR(500),
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_notification_cycle (attendance_id, recipient_type, cycle_number),
  FOREIGN KEY (attendance_id) REFERENCES Attendance(id) ON DELETE CASCADE
);

ALTER TABLE WhatsApp_Notifications
  MODIFY status ENUM('pending','sending','sent','delivered','failed','corrected') NOT NULL DEFAULT 'pending';
