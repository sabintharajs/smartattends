import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, Bell, BookOpen, CalendarDays,
  Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3,
  FileSpreadsheet, LayoutDashboard, LogOut, Menu, Plus, Search, Settings2, ShieldCheck,
  SlidersHorizontal, Trash2, Users, X,
} from 'lucide-react';

const today = () => new Date().toLocaleDateString('en-CA');
const initials = (name = '') => name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
const showDate = (value) => value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const emptyRoleCredentials = () => ({
  faculty: { loginId: '', password: '' },
  student: { loginId: '', password: '' },
  admin: { loginId: '', password: '' },
  hod: { loginId: '', password: '' },
});

function pagesForRole(role) {
  return [
    'dashboard',
    ...(!['hod', 'student'].includes(role) ? ['attendance'] : []),
    ...(['admin', 'hod'].includes(role) ? ['management'] : []),
    ...(role !== 'student' ? ['reports', 'notifications'] : []),
  ];
}

function pageUrl(page) {
  const url = new URL(window.location.href);
  if (page === 'dashboard') url.searchParams.delete('page');
  else url.searchParams.set('page', page);
  return `${url.pathname}${url.search}${url.hash}`;
}

function currentHistoryPage() {
  return new URLSearchParams(window.location.search).get('page')
    || window.history.state?.smartAttendancePage
    || 'dashboard';
}

function api(token, path, options = {}) {
  return fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  }).then(async (response) => {
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await response.json().catch(() => ({}))
      : response.ok
        ? {}
        : {
          error: response.status === 404
            ? `API route /api${path} was not found on the running server. Stop any older server process and start this project's Express server.`
            : `The request failed with status ${response.status}. Please try again.`,
        };
    if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  });
}

function Login({ onLogin }) {
  const [role, setRole] = useState('faculty');
  const [mode, setMode] = useState(() => new URLSearchParams(window.location.search).has('reset') ? 'reset' : 'login');
  const [credentials, setCredentials] = useState(emptyRoleCredentials);
  const authRequestVersion = useRef(0);
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.search).get('reset') || '');
  const [resetIdentifier, setResetIdentifier] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [registration, setRegistration] = useState({});
  const [options, setOptions] = useState({ departments: [], classes: [] });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const { loginId, password } = credentials[role];

  function changeRole(nextRole) {
    authRequestVersion.current += 1;
    setRole(nextRole);
    setCredentials(emptyRoleCredentials());
    setError('');
    setSuccess('');
  }

  function updateCredential(field, value) {
    setCredentials((current) => ({
      ...current,
      [role]: { ...current[role], [field]: value },
    }));
  }

  useEffect(() => {
    if (!resetToken) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('reset');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [resetToken]);

  useEffect(() => {
    if (mode !== 'register') return;
    api(null, '/auth/options').then(setOptions).catch((requestError) => setError(requestError.message));
  }, [mode]);

  async function submit(event) {
    event.preventDefault();
    const requestVersion = authRequestVersion.current;
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      if (mode === 'forgot') {
        const result = await api(null, '/auth/forgot-password', {
          method: 'POST',
          body: { identifier: resetIdentifier },
        });
        setSuccess(result.message);
      } else if (mode === 'reset') {
        if (newPassword !== confirmNewPassword) {
          setError('Passwords do not match.');
          return;
        }
        const result = await api(null, '/auth/reset-password', {
          method: 'POST',
          body: { token: resetToken, password: newPassword, confirmPassword: confirmNewPassword },
        });
        setSuccess(result.message);
        setMode('login');
        setResetToken('');
        setNewPassword('');
        setConfirmNewPassword('');
      } else if (mode === 'register') {
        if (registration.password !== registration.confirmPassword) {
          setError('Passwords do not match.');
          return;
        }
        const { confirmPassword, ...body } = registration;
        const result = await api(null, '/auth/register', { method: 'POST', body: { ...body, role } });
        if (requestVersion !== authRequestVersion.current) return;
        setSuccess(result.message);
        setMode('login');
        setRole(role);
        setCredentials((current) => ({
          ...current,
          [role]: {
            loginId: role === 'faculty' ? registration.facultyCode : role === 'student' ? registration.email : registration.loginId,
            password: '',
          },
        }));
        setRegistration({});
      } else {
        const submittedRole = role;
        const result = await api(null, '/auth/login', { method: 'POST', body: { role: submittedRole, loginId, password } });
        if (requestVersion !== authRequestVersion.current) return;
        if (result.user?.role !== submittedRole) {
          throw new Error('The selected portal does not match the account role.');
        }
        onLogin(result);
      }
    } catch (requestError) {
      if (requestVersion === authRequestVersion.current) setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }
  

  return (
    <main className="login-page">
      <section className="login-visual">
        <div className="brand brand-light"><span className="brand-mark"><Activity size={21} /></span><span>Smart<span>Attend</span></span></div>
        <div className="login-story">
          <div className="eyebrow"><span className="live-dot" /> CAMPUS OPERATIONS, SIMPLIFIED</div>
          <h1>Every period.<br />Every student.<br /><span>Accounted for.</span></h1>
          <p>A smarter way to manage college attendance, keep faculty in sync, and keep families informed.</p>
        </div>
        <div className="login-foot"><span>Designed for your campus</span><span>Secure · Reliable · Connected</span></div>
        <div className="visual-orbit orbit-one" /><div className="visual-orbit orbit-two" />
      </section>
      <section className="login-form-side">
        <div className="mobile-brand brand"><span className="brand-mark"><Activity size={21} /></span><span>Smart<span>Attend</span></span></div>
        <form className={`login-card ${mode === 'register' ? 'register-card' : ''}`} onSubmit={submit}>
          <div className="login-heading"><span className="welcome-icon"><ShieldCheck size={20} /></span><div className="eyebrow">{mode === 'register' ? 'JOIN YOUR COLLEGE' : mode === 'forgot' || mode === 'reset' ? 'ACCOUNT RECOVERY' : 'WELCOME BACK'}</div><h2>{mode === 'register' ? 'Create an account' : mode === 'forgot' ? 'Forgot your password?' : mode === 'reset' ? 'Set a new password' : 'Sign in to your portal'}</h2><p>{mode === 'register' ? 'Submit your details for administrator approval.' : mode === 'forgot' ? 'Enter your registered email address or login ID.' : mode === 'reset' ? 'Choose a strong password for your account.' : 'Choose your account type and enter your credentials.'}</p></div>
          {mode === 'login' ? <>
            <div className="role-picker" aria-label="Select portal">
              {[['faculty', 'Faculty'], ['hod', 'HOD'], ['student', 'Student'], ['admin', 'Admin']].map(([value, label]) => (
                <button type="button" className={role === value ? 'role-option selected' : 'role-option'} key={value} onClick={() => changeRole(value)}>{label}</button>
              ))}
            </div>
            <label className="field-label" htmlFor="login-id">{role === 'admin' || role === 'student' ? 'Email address' : `${role === 'hod' ? 'HOD' : 'Faculty'} ID`}</label>
            <input id="login-id" className="text-input" autoComplete="username" value={loginId} onChange={(event) => updateCredential('loginId', event.target.value)} placeholder={role === 'admin' || role === 'student' ? 'name@college.edu' : 'Enter your ID'} required />
            <div className="field-row"><label className="field-label" htmlFor="password">Password</label><button type="button" className="forgot-link" onClick={() => { setMode('forgot'); setError(''); setSuccess(''); }}>Forgot Password?</button></div>
            <input id="password" className="text-input" type="password" autoComplete="current-password" value={password} onChange={(event) => updateCredential('password', event.target.value)} placeholder="Enter your password" required />
          </> : mode === 'register' ? <>
            <div className="role-picker" aria-label="Select account type">
              {[['faculty', 'Faculty'], ['student', 'Student'], ['hod', 'HOD']].map(([value, label]) => (
                <button type="button" className={role === value ? 'role-option selected' : 'role-option'} key={value} onClick={() => { changeRole(value); setRegistration({}); }}>{label}</button>
              ))}
            </div>
            {[
              ['name', 'Full name', 'text'],
              ...(role === 'faculty' ? [['facultyCode', 'Faculty ID', 'text'], ['email', 'Email address', 'email']] : []),
              ...(role === 'student' ? [['email', 'Email address', 'email'], ['registerNumber', 'Register number', 'text'], ['rollNumber', 'Roll number', 'text'], ['parentName', 'Parent / guardian name (optional)', 'text'], ['parentWhatsApp', 'Parent WhatsApp (+country code, optional)', 'tel']] : []),
              ...(role === 'hod' ? [['loginId', 'HOD login ID', 'text'], ['email', 'Email address', 'email'], ['whatsappNumber', 'WhatsApp number (+country code)', 'tel']] : []),
            ].map(([field, label, type]) => <label className="registration-field" key={field}><span className="field-label">{label}</span><input className="text-input" type={type} autoComplete={field === 'email' ? 'email' : field === 'name' ? 'name' : 'off'} value={registration[field] || ''} onChange={(event) => setRegistration({ ...registration, [field]: event.target.value, ...(field === 'parentWhatsApp' && !event.target.value ? { parentWhatsAppConsent: false } : {}) })} required={!['parentName', 'parentWhatsApp'].includes(field)} /></label>)}
            {role === 'student' && <label className="consent-field registration-consent"><input type="checkbox" checked={registration.parentWhatsAppConsent || false} disabled={!registration.parentWhatsApp} onChange={(event) => setRegistration({ ...registration, parentWhatsAppConsent: event.target.checked })} /><span>I confirm the parent/guardian has consented to receive WhatsApp attendance notifications.</span></label>}
            {role === 'faculty' || role === 'hod' ? <label className="registration-field"><span className="field-label">Department</span><select className="text-input" value={registration.departmentId || ''} onChange={(event) => setRegistration({ ...registration, departmentId: Number(event.target.value) })} required><option value="">Choose your department</option>{options.departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
            {role === 'student' && <label className="registration-field"><span className="field-label">Class</span><select className="text-input" value={registration.classId || ''} onChange={(event) => setRegistration({ ...registration, classId: Number(event.target.value) })} required><option value="">Choose your class</option>{options.classes.map((item) => <option key={item.id} value={item.id}>{item.department} · Year {item.year} · {item.section} ({item.academicYear})</option>)}</select></label>}
            <label className="registration-field"><span className="field-label">Password (at least 12 characters)</span><input className="text-input" type="password" autoComplete="new-password" minLength={12} value={registration.password || ''} onChange={(event) => setRegistration({ ...registration, password: event.target.value })} required /></label>
            <label className="registration-field"><span className="field-label">Confirm password</span><input className="text-input" type="password" autoComplete="new-password" minLength={12} value={registration.confirmPassword || ''} onChange={(event) => setRegistration({ ...registration, confirmPassword: event.target.value })} required /></label>
          </> : mode === 'forgot' ? <label className="registration-field"><span className="field-label">Email address or Login ID</span><input className="text-input" type="text" autoComplete="username" value={resetIdentifier} onChange={(event) => setResetIdentifier(event.target.value)} required /></label> : <>
            <label className="registration-field"><span className="field-label">New password</span><input className="text-input" type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
            <label className="registration-field"><span className="field-label">Confirm new password</span><input className="text-input" type="password" autoComplete="new-password" minLength={12} value={confirmNewPassword} onChange={(event) => setConfirmNewPassword(event.target.value)} required /></label>
            <p className="password-requirements">Use at least 12 characters with uppercase and lowercase letters, a number, and a symbol.</p>
          </>}
          {success && <div className="form-success" role="status">{success}</div>}
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="button button-primary login-submit" disabled={loading}>{loading ? mode === 'register' ? 'Submitting…' : mode === 'forgot' ? 'Sending…' : mode === 'reset' ? 'Updating…' : 'Signing in…' : mode === 'register' ? 'Submit registration' : mode === 'forgot' ? 'Send reset link' : mode === 'reset' ? 'Reset password' : 'Sign in'} <ArrowRight size={17} /></button>
          {mode !== 'login' && <button type="button" className="auth-switch" onClick={() => { setMode('login'); setCredentials(emptyRoleCredentials()); setError(''); setSuccess(''); }}>{mode === 'register' ? 'Already have an account? Sign in' : 'Back to sign in'}</button>}
          {mode === 'login' && <button type="button" className="auth-switch" onClick={() => { setMode('register'); if (role === 'admin') changeRole('faculty'); setCredentials(emptyRoleCredentials()); setError(''); setSuccess(''); }}>Need an account? Sign up</button>}
          <div className="login-security"><ShieldCheck size={15} /> {mode === 'register' ? 'New accounts require college administrator approval' : mode === 'forgot' ? 'If email delivery is unavailable, contact your college administrator.' : mode === 'reset' ? 'Reset links expire after 30 minutes and work only once.' : 'Your sign-in is protected with secure authentication'}</div>
        </form>
        <div className="login-copyright">© {new Date().getFullYear()} Smart Attendance Management System</div>
      </section>
    </main>
  );
}

function App() {
  const [session, setSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem('smart-attendance-session')); } catch { return null; }
  });
  const [page, setPage] = useState(() => {
    const savedSession = (() => {
      try { return JSON.parse(localStorage.getItem('smart-attendance-session')); } catch { return null; }
    })();
    const requestedPage = currentHistoryPage();
    return pagesForRole(savedSession?.user?.role).includes(requestedPage) ? requestedPage : 'dashboard';
  });
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (session?.token) localStorage.setItem('smart-attendance-session', JSON.stringify(session));
    else localStorage.removeItem('smart-attendance-session');
  }, [session]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!session?.token) return undefined;
    const syncPage = () => {
      const requestedPage = currentHistoryPage();
      const nextPage = pagesForRole(session.user?.role).includes(requestedPage)
        ? requestedPage
        : 'dashboard';
      if (nextPage !== requestedPage) {
        window.history.replaceState({ smartAttendancePage: nextPage }, '', pageUrl(nextPage));
      }
      setPage(nextPage);
      setMobileNav(false);
    };

    if (!pagesForRole(session.user?.role).includes(currentHistoryPage())) {
      window.history.replaceState({ smartAttendancePage: 'dashboard' }, '', pageUrl('dashboard'));
      setPage('dashboard');
    } else if (!window.history.state?.smartAttendancePage) {
      window.history.replaceState({ smartAttendancePage: page }, '', pageUrl(page));
    }

    window.addEventListener('popstate', syncPage);
    return () => window.removeEventListener('popstate', syncPage);
  }, [session, page]);

  const navigatePage = (nextPage) => {
    if (!session?.token || !pagesForRole(session.user?.role).includes(nextPage) || nextPage === page) return;
    window.history.pushState({ smartAttendancePage: nextPage }, '', pageUrl(nextPage));
    setPage(nextPage);
    setMobileNav(false);
  };

  const login = (nextSession) => {
    window.history.replaceState({ smartAttendancePage: 'dashboard' }, '', pageUrl('dashboard'));
    setSession(nextSession);
    setPage('dashboard');
  };

  if (!session?.token) return <Login onLogin={login} />;

  const { token, user = {} } = session;
  const nav = [
    { key: 'dashboard', label: 'Overview', icon: LayoutDashboard },
    ...(!['hod', 'student'].includes(user.role) ? [{ key: 'attendance', label: 'Mark attendance', icon: CheckCircle2 }] : []),
    ...(['admin', 'hod'].includes(user.role) ? [{ key: 'management', label: 'Manage college', icon: Settings2 }] : []),
    ...(user.role !== 'student' ? [{ key: 'reports', label: 'Reports', icon: FileSpreadsheet }] : []),
    ...(user.role !== 'student' ? [{ key: 'notifications', label: 'Notifications', icon: Bell }] : []),
  ];
  const handleLogout = () => {
    localStorage.removeItem('smart-attendance-session');
    window.history.replaceState(null, '', pageUrl('dashboard'));
    setSession(null);
    setPage('dashboard');
    setMobileNav(false);
  };

  return (
    <div className="app-shell">
      {mobileNav && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
      <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand brand"><span className="brand-mark"><Activity size={21} /></span><span>Smart<span>Attend</span></span></div>
        <div className="workspace-label">WORKSPACE</div>
        <div className="workspace-switch"><span className="workspace-avatar">SC</span><span><b>St. Catherine's</b><small>College portal</small></span><ChevronDown size={15} /></div>
        <div className="nav-label">MENU</div>
        <nav className="primary-nav">
          {nav.map(({ key, label, icon: Icon }) => <button key={key} className={`nav-item ${page === key ? 'nav-active' : ''}`} onClick={() => navigatePage(key)}><Icon size={18} /><span>{label}</span>{key === 'notifications' && <span className="nav-indicator" />}</button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="support-card"><span className="support-icon"><CircleHelp size={17} /></span><div><b>Need a hand?</b><p>Visit the help center</p></div><ArrowRight size={15} /></div>
          <div className="sidebar-user"><span className="user-avatar">{initials(user.name || user.loginId)}</span><div className="sidebar-user-name"><b>{user.name || user.loginId}</b><span>{user.role === 'hod' ? 'Head of Department' : user.role === 'admin' ? 'Administrator' : user.role === 'student' ? 'Student' : 'Faculty member'}</span></div><button className="icon-button logout-button" title="Sign out" aria-label="Sign out" onClick={handleLogout}><LogOut size={17} /></button></div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={20} /></button>
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><b>{nav.find((item) => item.key === page)?.label || 'Overview'}</b></div>
          <button className="center-logout" onClick={handleLogout}><LogOut size={15} /><span>Sign out</span></button>
          <div className="topbar-actions"><span className="today-chip"><CalendarDays size={15} /> {new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</span>{user.role !== 'student' && <button className="icon-button notification-button" onClick={() => navigatePage('notifications')} aria-label="View notifications"><Bell size={18} /><i /></button>}<span className="user-avatar top-avatar">{initials(user.name || user.loginId)}</span></div>
        </header>
        <main className="content-area">
          {page === 'dashboard' && (user.role === 'student' ? <StudentDashboard token={token} /> : <Dashboard token={token} user={user} onNavigate={navigatePage} />)}
          {page === 'attendance' && <Attendance token={token} user={user} onToast={setToast} />}
          {page === 'management' && ['admin', 'hod'].includes(user.role) && <Management token={token} user={user} onToast={setToast} />}
          {page === 'reports' && <Reports token={token} />}
          {page === 'notifications' && <Notifications token={token} user={user} onToast={setToast} />}
        </main>
        <footer className="app-footer"><span>© {new Date().getFullYear()} Smart Attendance</span><span><span className="footer-status" /> All systems operational <span className="footer-separator">·</span> Academic year 2026–27</span></footer>
      </div>
      {toast && <div className="toast"><Check size={17} /> {toast}</div>}
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function StudentDashboard({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(token, '/student/attendance').then(setData).catch((requestError) => setError(requestError.message));
  }, [token]);
  const records = data?.records || [];
  const rate = data?.summary?.total ? Math.round((data.summary.present / data.summary.total) * 100) : 0;

  return <>
    <PageHeading eyebrow="STUDENT PORTAL" title={`Welcome, ${data?.student?.name || 'student'}`} description="Review your attendance record and class details." />
    {error && <div className="notice-error" role="alert">{error}</div>}
    {data && <section className="panel student-profile-card"><div><span className="eyebrow">YOUR CLASS</span><h2>{data.student.department} · Year {data.student.year} · {data.student.section}</h2><p>{data.student.academicYear} · Register number {data.student.registerNumber}</p></div><div className="student-attendance-rate"><strong>{rate}%</strong><span>Attendance</span></div></section>}
    <section className="panel recent-panel student-attendance-panel">
      <div className="roster-toolbar"><div><h2>Attendance history</h2><p>Showing your latest {records.length} recorded periods</p></div><span className="secure-badge"><ShieldCheck size={15} /> Private to you</span></div>
      {records.length ? <div className="table-scroll"><table><thead><tr><th>DATE</th><th>SUBJECT</th><th>PERIOD</th><th>STATUS</th></tr></thead><tbody>{records.map((record, index) => <tr key={`${record.date}-${record.periodId}-${index}`}><td>{showDate(record.date)}</td><td>{record.subject}</td><td>Period {record.period}</td><td><span className={`notification-status ${record.status}`}>{record.status}</span></td></tr>)}</tbody></table></div> : <div className="empty-state"><span className="empty-icon"><CalendarDays size={20} /></span><b>{data ? 'No attendance recorded yet' : 'Loading your attendance…'}</b><p>Your submitted attendance will appear here.</p></div>}
    </section>
  </>;
}

function Dashboard({ token, user, onNavigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(token, '/dashboard').then(setData).catch((requestError) => setError(requestError.message));
  }, [token]);
  const summary = data?.summary || {};
  const rate = summary.totalToday ? Math.round((summary.present / summary.totalToday) * 100) : 0;
  const present = Number(summary.present || 0);
  const absent = Number(summary.absent || 0);
  const total = present + absent;
  const circumference = 2 * Math.PI * 67;
  const presentLength = total ? circumference * present / total : 0;
  const absentLength = total ? circumference * absent / total : 0;

  return <>
    <PageHeading eyebrow="CAMPUS AT A GLANCE" title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${user.name?.split(' ')[0] || 'there'}`} description="Here's what's happening across your campus today." action={<button className="button button-secondary" onClick={() => onNavigate('reports')}><ArrowDownToLine size={16} /> Export report</button>} />
    {error && <div className="notice-error" role="alert">{error}</div>}
    <div className="stats-grid">
      <StatCard label="Total students" value={summary.students} icon={Users} tint="blue" foot="Across active classes" />
      <StatCard label="Faculty members" value={summary.faculty} icon={BookOpen} tint="purple" foot="Active teaching staff" />
      <StatCard label="Attendance marked" value={summary.totalToday} icon={CheckCircle2} tint="green" foot={`${rate}% present today`} />
      <StatCard label="Absent today" value={summary.absent} icon={Bell} tint="coral" foot="Notifications triggered" />
    </div>
    <div className="dashboard-grid">
      <section className="panel period-panel">
        <div className="panel-heading"><div><h2>Period-wise attendance</h2><p>Today's class attendance at a glance</p></div><span className="panel-tag"><span className="live-dot" /> TODAY</span></div>
        {data?.periods?.length ? <div className="period-bars">{data.periods.map((period) => {
          const percentage = period.total ? Math.round((period.present / period.total) * 100) : 0;
          return <div className="period-bar-item" key={period.period}><div className="period-bar-label"><b>Period {period.period}</b><span>{period.total ? `${percentage}%` : '—'}</span></div><div className="progress-track"><div className={`progress-fill ${percentage < 70 && period.total ? 'progress-warning' : ''}`} style={{ width: `${percentage}%` }} /></div><div className="period-bar-meta">{period.total ? `${period.present || 0} present · ${period.absent || 0} absent` : 'Not marked yet'}</div></div>;
        })}</div> : <div className="chart-empty">{data ? 'No periods configured yet.' : <span className="loading-skeleton" />}</div>}
      </section>
      <section className="panel attendance-panel">
        <div className="panel-heading"><div><h2>Today's attendance</h2><p>Overall student status</p></div><button className="icon-button subtle-icon" onClick={() => onNavigate('reports')} aria-label="Open reports"><ArrowRight size={17} /></button></div>
        <div className="donut-wrap"><svg className="donut-chart" viewBox="0 0 180 180" role="img" aria-label={`${present} present and ${absent} absent`}><circle cx="90" cy="90" r="67" fill="none" stroke="#f0f3f7" strokeWidth="14" /><circle cx="90" cy="90" r="67" fill="none" stroke="#18a879" strokeWidth="14" strokeDasharray={`${presentLength} ${circumference}`} transform="rotate(-90 90 90)" /><circle cx="90" cy="90" r="67" fill="none" stroke="#f16c73" strokeWidth="14" strokeDasharray={`${absentLength} ${circumference}`} strokeDashoffset={-presentLength} transform="rotate(-90 90 90)" /></svg><div className="donut-center"><strong>{rate}%</strong><span>Present</span></div></div>
        <div className="legend-row"><span><i className="legend-dot green-dot" />Present <b>{summary.present || 0}</b></span><span><i className="legend-dot coral-dot" />Absent <b>{summary.absent || 0}</b></span></div>
      </section>
    </div>
    <div className="insights-grid">
      <section className="panel department-panel"><div className="panel-heading"><div><h2>Department attendance</h2><p>Today's attendance rate by department</p></div><span className="panel-tag"><CalendarDays size={13} /> TODAY</span></div>
        {data?.departmentAttendance?.length ? <div className="department-list">{data.departmentAttendance.map((item) => {
          const percentage = item.total ? Math.round((item.present / item.total) * 100) : 0;
          return <div className="department-row" key={item.id}><div className="department-row-heading"><b>{item.department}</b><span>{item.total ? `${percentage}%` : '—'}</span></div><div className="progress-track"><div className={`progress-fill ${percentage < 70 && item.total ? 'progress-warning' : ''}`} style={{ width: `${percentage}%` }} /></div><small>{item.total ? `${item.present || 0} present of ${item.total} marked` : 'Attendance not marked yet'}</small></div>;
        })}</div> : <div className="empty-state compact-empty"><b>{data ? 'No departments configured' : 'Loading department data…'}</b></div>}
      </section>
      <section className="panel frequent-panel"><div className="panel-heading"><div><h2>Frequent absences</h2><p>3 or more absences in the last 30 days</p></div><span className="panel-tag">LAST 30 DAYS</span></div>
        {data?.frequentAbsences?.length ? <div className="frequent-list">{data.frequentAbsences.map((item) => <div className="frequent-row" key={item.registerNumber}><span className="student-avatar avatar-4">{initials(item.student)}</span><span className="frequent-student"><b>{item.student}</b><small>{item.department} · {item.year}-{item.section}</small></span><span className="absence-count">{item.absences}<small>absences</small></span></div>)}</div> : <div className="empty-state compact-empty"><span className="empty-icon"><CheckCircle2 size={19} /></span><b>{data ? 'No frequent absences' : 'Loading student records…'}</b><p>Students with 3+ absences appear here.</p></div>}
      </section>
    </div>
    <section className="panel recent-panel">
      <div className="panel-heading"><div><h2>Recent absence alerts</h2><p>Students marked absent in today's periods</p></div><button className="text-button" onClick={() => onNavigate('notifications')}>View notifications <ArrowRight size={15} /></button></div>
      {data?.recentAbsences?.length ? <div className="table-scroll"><table><thead><tr><th>STUDENT</th><th>CLASS</th><th>PERIOD</th><th>SUBJECT</th><th>FACULTY</th><th>DATE</th></tr></thead><tbody>{data.recentAbsences.map((record) => <tr key={record.id}><td><div className="student-cell"><span className="student-avatar">{initials(record.student)}</span><span><b>{record.student}</b><small>{record.registerNumber}</small></span></div></td><td>{record.department} · {record.year}-{record.section}</td><td><span className="period-pill">P{record.period}</span></td><td>{record.subject}</td><td>{record.faculty}</td><td>{showDate(record.date)}</td></tr>)}</tbody></table></div> : <div className="empty-state"><span className="empty-icon"><CheckCircle2 size={21} /></span><b>{data ? 'No absences recorded today' : 'Loading attendance alerts…'}</b><p>New alerts will appear here after attendance is submitted.</p></div>}
    </section>
  </>;
}

function StatCard({ label, value, icon: Icon, tint, foot }) {
  return <article className="stat-card"><div className={`stat-icon ${tint}`}><Icon size={19} /></div><span className="stat-label">{label}</span><div className="stat-value">{value === undefined ? <span className="loading-skeleton number-skeleton" /> : Number(value).toLocaleString()}</div><div className="stat-foot"><span className={`stat-foot-dot ${tint}`} />{foot}</div></article>;
}

function Attendance({ token, user, onToast }) {
  const [classes, setClasses] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [students, setStudents] = useState([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedAssignment, setSelectedAssignment] = useState('');
  const [attendanceDate, setAttendanceDate] = useState(today());
  const [statuses, setStatuses] = useState({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api(token, '/classes'), api(token, '/periods')]).then(([classData, periodData]) => {
      setClasses(classData.classes);
      setPeriods(periodData.periods);
      if (classData.classes.length) setSelectedClass(String(classData.classes[0].id));
    }).catch((requestError) => setError(requestError.message));
  }, [token]);

  useEffect(() => {
    setAssignments([]);
    setStudents([]);
    setSelectedAssignment('');
    if (!selectedClass) return;
    api(token, `/assignments?classId=${selectedClass}&date=${attendanceDate}`).then((result) => {
      setAssignments(result.assignments);
      if (result.assignments.length) setSelectedAssignment(`${result.assignments[0].period_id}:${result.assignments[0].subject_id}`);
    }).catch((requestError) => setError(requestError.message));
  }, [token, selectedClass, attendanceDate]);

  const assignment = assignments.find((item) => `${item.period_id}:${item.subject_id}` === selectedAssignment);
  const loadRoster = useCallback(async () => {
    if (!selectedClass || !assignment) return;
    setError('');
    setLoading(true);
    try {
      const [roster, existing] = await Promise.all([
        api(token, `/students?classId=${selectedClass}`),
        api(token, `/attendance?date=${attendanceDate}&classId=${selectedClass}&periodId=${assignment.period_id}&subjectId=${assignment.subject_id}`),
      ]);
      setStudents(roster.students);
      const next = Object.fromEntries(roster.students.map((student) => [student.id, 'present']));
      existing.records.forEach((record) => { next[record.studentId] = record.status; });
      setStatuses(next);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [token, selectedClass, assignment, attendanceDate]);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  const visibleStudents = useMemo(() => students.filter((student) => `${student.name} ${student.register_number} ${student.roll_number}`.toLowerCase().includes(search.toLowerCase())), [students, search]);
  const presentCount = Object.values(statuses).filter((status) => status === 'present').length;
  const absentCount = Object.values(statuses).filter((status) => status === 'absent').length;

  async function submitAttendance() {
    if (!assignment || !students.length) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api(token, '/attendance', {
        method: 'POST',
        body: {
          classId: Number(selectedClass), subjectId: assignment.subject_id,
          periodId: assignment.period_id, attendanceDate,
          records: students.map((student) => ({ studentId: student.id, status: statuses[student.id] || 'present' })),
        },
      });
      onToast(`Attendance saved for ${result.submitted} students.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return <>
    <PageHeading eyebrow="CLASSROOM WORKSPACE" title="Mark attendance" description="Record student presence for each assigned period." action={<span className="secure-badge"><ShieldCheck size={15} /> Secure submission</span>} />
    <section className="panel attendance-controls">
      <div className="selection-grid">
        <label className="select-field"><span>CLASS</span><div className="select-wrap"><Users size={16} /><select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value)}><option value="">Select a class</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.department} · Year {item.year} · {item.section}</option>)}</select><ChevronDown size={15} /></div></label>
        <label className="select-field"><span>SUBJECT & PERIOD</span><div className="select-wrap"><BookOpen size={16} /><select value={selectedAssignment} onChange={(event) => setSelectedAssignment(event.target.value)}><option value="">Select assignment</option>{assignments.map((item) => <option key={`${item.period_id}:${item.subject_id}`} value={`${item.period_id}:${item.subject_id}`}>Period {item.period_number} · {item.subject}</option>)}</select><ChevronDown size={15} /></div></label>
        <label className="select-field"><span>ATTENDANCE DATE</span><div className="select-wrap"><CalendarDays size={16} /><input type="date" max={today()} value={attendanceDate} onChange={(event) => setAttendanceDate(event.target.value)} /></div></label>
      </div>
      {assignment && <div className="assignment-strip"><span className="assignment-icon"><Clock3 size={16} /></span><span><b>Period {assignment.period_number}</b><small>{String(assignment.start_time).slice(0, 5)} – {String(assignment.end_time).slice(0, 5)}</small></span><span className="strip-divider" /><span><b>{assignment.subject}</b><small>{assignment.faculty}</small></span><span className="strip-class">{classes.find((item) => String(item.id) === selectedClass)?.department} · {classes.find((item) => String(item.id) === selectedClass)?.year}-{classes.find((item) => String(item.id) === selectedClass)?.section}</span></div>}
    </section>
    <section className="panel roster-panel">
      <div className="roster-toolbar"><div><h2>Student roster</h2><p>{students.length} students in this class</p></div><div className="roster-toolbar-right"><div className="search-wrap"><Search size={16} /><input aria-label="Search students" placeholder="Search students…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><button className="button button-secondary compact-button" onClick={() => setStatuses(Object.fromEntries(students.map((student) => [student.id, 'present'])))} disabled={!students.length}><CheckCircle2 size={15} /> All present</button></div></div>
      <div className="attendance-summary"><span><i className="legend-dot green-dot" /><b>{presentCount}</b> Present</span><span><i className="legend-dot coral-dot" /><b>{absentCount}</b> Absent</span><span className="summary-total">{students.length} students</span></div>
      {error && <div className="notice-error inline-error" role="alert">{error}</div>}
      {loading ? <div className="empty-state"><span className="loading-skeleton" /></div> : visibleStudents.length ? <div className="table-scroll"><table className="roster-table"><thead><tr><th>STUDENT</th><th>REGISTER NUMBER</th><th>ROLL NO.</th><th className="status-heading">ATTENDANCE STATUS</th></tr></thead><tbody>{visibleStudents.map((student, index) => <tr key={student.id}><td><div className="student-cell"><span className={`student-avatar avatar-${index % 5}`}>{initials(student.name)}</span><span><b>{student.name}</b></span></div></td><td>{student.register_number}</td><td>{student.roll_number}</td><td><div className="status-toggle"><button className={statuses[student.id] === 'present' ? 'status-choice present-selected' : 'status-choice'} onClick={() => setStatuses({ ...statuses, [student.id]: 'present' })}><Check size={14} /> Present</button><button className={statuses[student.id] === 'absent' ? 'status-choice absent-selected' : 'status-choice'} onClick={() => setStatuses({ ...statuses, [student.id]: 'absent' })}><X size={14} /> Absent</button></div></td></tr>)}</tbody></table></div> : <div className="empty-state"><span className="empty-icon"><Users size={20} /></span><b>{students.length ? 'No matching students' : 'Select an assigned class and period'}</b><p>{students.length ? 'Try another name or register number.' : 'The student list will appear once your class and period are selected.'}</p></div>}
      <div className="submit-footer"><span><ShieldCheck size={15} /> Absent students with a consented parent contact will receive a WhatsApp alert.</span><button className="button button-primary" disabled={submitting || loading || students.length === 0} onClick={submitAttendance}>{submitting ? 'Submitting…' : 'Submit attendance'} <ArrowRight size={16} /></button></div>
    </section>
  </>;
}

const setupKinds = [
  { type: 'department', title: 'Department', description: 'Create a department', fields: [['name', 'Department name'], ['code', 'Department code'], ['hodName', 'HOD name']] },
  { type: 'class', title: 'Class', description: 'Add an academic class', fields: [['departmentId', 'Department', 'select:departments'], ['year', 'Year', 'number'], ['section', 'Section'], ['academicYear', 'Academic year']] },
  { type: 'student', title: 'Student', description: 'Add a student and parent contact', fields: [['name', 'Student name'], ['registerNumber', 'Register number'], ['rollNumber', 'Roll number'], ['classId', 'Class', 'select:classes'], ['parentName', 'Parent name'], ['parentWhatsApp', 'Parent WhatsApp (+country code)'], ['parentWhatsAppConsent', 'Parent/guardian consent for absence alerts', 'checkbox'], ['email', 'Student email'], ['photoUrl', 'Student photo URL']] },
  { type: 'faculty', title: 'Faculty', description: 'Create faculty profile and login', fields: [['facultyCode', 'Faculty ID'], ['name', 'Faculty name'], ['email', 'Email address'], ['departmentId', 'Department', 'select:departments'], ['password', 'Temporary password (12+ characters)', 'password']] },
  { type: 'hod', title: 'HOD contact', description: 'Register HOD login and WhatsApp number', fields: [['name', 'HOD name'], ['loginId', 'HOD login ID'], ['email', 'HOD email address', 'email'], ['departmentId', 'Department', 'select:departments'], ['whatsappNumber', 'HOD WhatsApp (+country code)'], ['password', 'Temporary password (12+ characters)', 'password']] },
  { type: 'subject', title: 'Subject', description: 'Add a department subject', fields: [['subjectCode', 'Subject code'], ['name', 'Subject name'], ['departmentId', 'Department', 'select:departments']] },
  { type: 'period', title: 'Period', description: 'Configure or update a period', fields: [['periodNumber', 'Period number', 'number'], ['startTime', 'Start time', 'time'], ['endTime', 'End time', 'time'], ['submissionDeadlineMinutes', 'Editing window (minutes)', 'number']] },
  { type: 'assignment', title: 'Timetable assignment', description: 'Assign subject, faculty and period', fields: [['classId', 'Class', 'select:classes'], ['subjectId', 'Subject', 'select:subjects'], ['facultyId', 'Faculty', 'select:faculty'], ['periodId', 'Period', 'select:periods'], ['dayOfWeek', 'Day of week', 'select:days']] },
];

function Management({ token, user, onToast }) {
  const isAdmin = user.role === 'admin';
  const [data, setData] = useState(null);
  const [requests, setRequests] = useState([]);
  const [requestsError, setRequestsError] = useState('');
  const [kind, setKind] = useState(setupKinds[0].type);
  const [values, setValues] = useState({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetForm, setResetForm] = useState({ loginId: '', password: '', confirmPassword: '' });
  const [resetError, setResetError] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [editId, setEditId] = useState(null);
  const [search, setSearch] = useState('');
  const selectedKind = setupKinds.find((item) => item.type === kind);

  const refresh = useCallback(() => api(token, '/admin/setup').then(setData).catch((requestError) => setError(requestError.message)), [token]);
  const refreshRequests = useCallback(() => api(token, '/admin/registrations').then((result) => setRequests(result.requests)).catch((requestError) => setRequestsError(requestError.message)), [token]);
  useEffect(() => {
    refresh();
    if (isAdmin) refreshRequests();
  }, [refresh, refreshRequests, isAdmin]);

  function changeKind(nextKind) {
    setKind(nextKind);
    setValues({});
    setEditId(null);
    setError('');
  }

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const body = { type: kind };
    for (const [field, , type] of selectedKind.fields) {
      const value = values[field] ?? '';
      body[field] = type === 'checkbox' ? Boolean(value) : type === 'number' || type?.startsWith('select:') ? Number(value) : value;
    }
    if (editId) body.id = editId;
    try {
      await api(token, '/admin/setup', { method: 'POST', body });
      await refresh();
      onToast(kind === 'student' && editId ? 'Student details updated.' : `${selectedKind.title} saved successfully.`);
      setValues({});
      setEditId(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  function choices(field) {
    const source = field === 'departments' ? data?.departments
      : field === 'classes' ? data?.classes
        : field === 'subjects' ? data?.subjects
          : field === 'faculty' ? data?.faculty
            : field === 'periods' ? data?.periods : [];
    if (field === 'days') return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day, index) => ({ id: index + 1, label: day }));
    return (source || []).map((item) => ({
      id: item.id,
      label: field === 'classes' ? `${item.department} · ${item.year}-${item.section}`
        : field === 'periods' ? `Period ${item.periodNumber}`
          : field === 'faculty' ? `${item.name} · ${item.facultyCode}`
            : item.name,
    }));
  }

  async function removeRecord(type, record) {
    const label = type === 'student' ? 'student' : type === 'faculty' ? 'faculty member' : type;
    const detail = type === 'department' || type === 'class'
      ? 'This can only be deleted if it has no dependent records.'
      : 'The account will be deactivated; attendance history will be retained.';
    if (!window.confirm(`Delete ${label} "${record.name || record.label}"? ${detail}`)) return;
    setError('');
    try {
      const result = await api(token, `/management/${type}/${record.id}`, { method: 'DELETE' });
      await refresh();
      onToast(result.message);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function decideRegistration(request, decision) {
    setRequestsError('');
    try {
      await api(token, `/admin/registrations/${request.id}`, { method: 'PATCH', body: { decision } });
      await refreshRequests();
      onToast(decision === 'approve' ? 'Registration approved; the account can now sign in.' : 'Registration rejected.');
    } catch (requestError) {
      setRequestsError(requestError.message);
    }
  }

  async function resetAccountPassword(event) {
    event.preventDefault();
    setResetError('');
    if (resetForm.password !== resetForm.confirmPassword) {
      setResetError('Passwords do not match.');
      return;
    }
    setResetLoading(true);
    try {
      const result = await api(token, '/admin/password-reset', {
        method: 'POST',
        body: resetForm,
      });
      setResetForm({ loginId: '', password: '', confirmPassword: '' });
      onToast(result.message);
    } catch (requestError) {
      setResetError(requestError.message);
    } finally {
      setResetLoading(false);
    }
  }

  const visibleStudents = (data?.students || []).filter((student) => `${student.name} ${student.registerNumber} ${student.department}`.toLowerCase().includes(search.toLowerCase()));
  const visibleRecords = (records) => records || [];
  return <>
    <PageHeading eyebrow={isAdmin ? 'COLLEGE ADMINISTRATION' : 'DEPARTMENT MANAGEMENT'} title={isAdmin ? 'Manage college' : 'Manage department'} description={isAdmin ? 'Configure departments, class rosters, staff, subjects and periods.' : 'Review and delete department records. Your access is limited to your department.'} action={<button className="button button-secondary" onClick={refresh}><Activity size={15} /> Refresh data</button>} />
    {error && <div className="notice-error" role="alert">{error}</div>}
    {!isAdmin && <HodAssignmentForm token={token} data={data} onToast={onToast} />}
    {isAdmin && <div className="management-layout">
      <section className="panel setup-panel">
        <div className="setup-panel-heading"><span className="filter-icon"><Settings2 size={17} /></span><div><h2>College setup</h2><p>Create records and manage academic configuration</p></div></div>
        <div className="setup-tabs">{setupKinds.map((item) => <button key={item.type} className={kind === item.type ? 'setup-tab selected' : 'setup-tab'} onClick={() => changeKind(item.type)}>{item.title}</button>)}</div>
        <div className="setup-form-heading"><div><h3>{editId ? 'Edit student details' : selectedKind.title}</h3><p>{editId ? 'Update student profile and parent contact.' : selectedKind.description}</p></div>{editId && <button className="text-button" onClick={() => { setEditId(null); setValues({}); }}>Cancel edit <X size={14} /></button>}</div>
        <form className="setup-form" onSubmit={submit}>
          {selectedKind.fields.map(([field, label, type]) => {
            const selectType = type?.startsWith('select:');
            const fieldOptions = selectType ? choices(type.slice(7)) : [];
            return <label className={type === 'checkbox' ? 'setup-field consent-field' : 'setup-field'} key={field}><span>{label}</span>{selectType
              ? <select required value={values[field] || ''} onChange={(event) => setValues({ ...values, [field]: event.target.value })}><option value="">Choose…</option>{fieldOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
              : type === 'checkbox'
                ? <input type="checkbox" checked={values[field] || false} onChange={(event) => setValues({ ...values, [field]: event.target.checked })} />
                : <input required={!['hodName', 'parentName', 'parentWhatsApp', 'email', 'photoUrl'].includes(field)} type={type || 'text'} min={type === 'number' ? (field === 'periodNumber' ? 1 : 0) : undefined} value={values[field] ?? (field === 'academicYear' ? '2026-27' : field === 'submissionDeadlineMinutes' ? '60' : '')} placeholder={field === 'parentWhatsApp' || field === 'whatsappNumber' ? '+14155552671' : ''} onChange={(event) => setValues({ ...values, [field]: event.target.value })} />}</label>;
          })}
          {error && <div className="form-error setup-error" role="alert">{error}</div>}
          <div className="setup-form-footer"><span><ShieldCheck size={14} /> Sensitive information is securely stored.</span><button className="button button-primary" disabled={loading}>{loading ? 'Saving…' : editId ? 'Save changes' : `Add ${selectedKind.title}`} <ArrowRight size={15} /></button></div>
        </form>
      </section>
      <section className="panel setup-summary">
        <div className="panel-heading"><div><h2>Configuration overview</h2><p>Current college records</p></div></div>
        <div className="setup-count-list">{[
          ['Departments', data?.departments?.length, 'blue'],
          ['Classes', data?.classes?.length, 'purple'],
          ['Students', data?.students?.length, 'green'],
          ['Faculty', data?.faculty?.length, 'coral'],
          ['Subjects', data?.subjects?.length, 'blue'],
          ['Periods', data?.periods?.length, 'purple'],
          ['Timetable assignments', data?.assignments?.length, 'green'],
        ].map(([label, count, color]) => <div className="setup-count-row" key={label}><span className={`setup-count-dot ${color}`} />{label}<b>{count ?? '—'}</b></div>)}</div>
        <div className="setup-tip"><span><CircleHelp size={15} /></span><p>Start by creating departments, then classes, subjects, staff and periods. Finish by assigning faculty to timetable slots.</p></div>
      </section>
    </div>}
    {isAdmin && <ManagementDirectory
      title="HOD directory"
      records={visibleRecords(data?.hods).map((hod) => ({
        ...hod,
        label: `${hod.name || 'HOD'} · ${hod.department}`,
        detail: [hod.loginId, hod.email, hod.whatsappNumber].filter(Boolean).join(' · ') || hod.department,
      }))}
      type="hod"
      onDelete={removeRecord}
      emptyMessage="No active HOD accounts found."
    />}
    {isAdmin && <section className="panel recent-panel registration-requests">
      <div className="roster-toolbar"><div><h2>Registration requests</h2><p>{requests.length} awaiting administrator approval</p></div><button className="button button-secondary compact-button" onClick={refreshRequests}><Activity size={14} /> Refresh</button></div>
      {requestsError && <div className="notice-error inline-error" role="alert">{requestsError}</div>}
      {requests.length ? <div className="registration-request-list">{requests.map((request) => {
        const profile = request.profile || {};
        const detail = request.role === 'faculty'
          ? `${request.department || 'Department pending'} · Faculty ID ${profile.facultyCode}`
          : request.role === 'student'
            ? `${request.department || 'Class pending'}${request.year ? ` · Year ${request.year}-${request.section}` : ''} · Register ${profile.registerNumber}`
            : `${request.department || 'Department pending'} · WhatsApp ${profile.whatsappNumber}`;
        return <article className="registration-request" key={request.id}><div className="registration-request-info"><span className="registration-role">{request.role}</span><b>{profile.name}</b><span>{request.loginId}</span><small>{detail}</small></div><div className="registration-request-actions"><button className="button button-primary" onClick={() => decideRegistration(request, 'approve')}>Approve</button><button className="button button-secondary" onClick={() => decideRegistration(request, 'reject')}>Reject</button></div></article>;
      })}</div> : <div className="empty-state"><b>No pending registration requests</b><p>New faculty, student, and HOD signups will appear here.</p></div>}
    </section>}
    {isAdmin && <section className="panel admin-password-reset">
      <div className="panel-heading"><div><h2>Admin password reset</h2><p>Set a new password for an active account when email recovery is unavailable.</p></div><span className="secure-badge"><ShieldCheck size={15} /> Admin only</span></div>
      <form className="admin-reset-form" onSubmit={resetAccountPassword}>
        <label className="registration-field"><span className="field-label">Account Login ID</span><input className="text-input" value={resetForm.loginId} onChange={(event) => setResetForm({ ...resetForm, loginId: event.target.value })} required /></label>
        <label className="registration-field"><span className="field-label">New password</span><input className="text-input" type="password" autoComplete="new-password" minLength={12} value={resetForm.password} onChange={(event) => setResetForm({ ...resetForm, password: event.target.value })} required /></label>
        <label className="registration-field"><span className="field-label">Confirm new password</span><input className="text-input" type="password" autoComplete="new-password" minLength={12} value={resetForm.confirmPassword} onChange={(event) => setResetForm({ ...resetForm, confirmPassword: event.target.value })} required /></label>
        {resetError && <div className="form-error setup-error" role="alert">{resetError}</div>}
        <div className="admin-reset-footer"><span>12+ characters, upper/lowercase, number, and symbol</span><button className="button button-primary" disabled={resetLoading}>{resetLoading ? 'Updating…' : 'Set password'} <ArrowRight size={15} /></button></div>
      </form>
    </section>}
    <ManagementDirectory
      title="Departments"
      records={visibleRecords(data?.departments).map((department) => ({ ...department, label: department.name, detail: department.code }))}
      type="department"
      onDelete={removeRecord}
      emptyMessage="No departments found."
    />
    <ManagementDirectory
      title="Classes"
      records={visibleRecords(data?.classes).map((classRecord) => ({ ...classRecord, label: `${classRecord.year}-${classRecord.section}`, detail: `${classRecord.department} · ${classRecord.academicYear}` }))}
      type="class"
      onDelete={removeRecord}
      emptyMessage="No classes found."
    />
    <ManagementDirectory
      title="Faculty"
      records={visibleRecords(data?.faculty).map((faculty) => ({ ...faculty, label: faculty.name, detail: `${faculty.facultyCode} · ${faculty.department}` }))}
      type="faculty"
      onDelete={removeRecord}
      emptyMessage="No active faculty found."
    />
    <section className="panel recent-panel student-management">
      <div className="roster-toolbar"><div><h2>Student directory</h2><p>{visibleStudents.length} active student profiles</p></div><div className="search-wrap"><Search size={16} /><input aria-label="Search student directory" placeholder="Search students…" value={search} onChange={(event) => setSearch(event.target.value)} /></div></div>
      {visibleStudents.length ? <div className="table-scroll"><table><thead><tr><th>STUDENT</th><th>REGISTER NUMBER</th><th>CLASS</th><th>PARENT WHATSAPP</th><th>ALERT CONSENT</th><th>EMAIL</th><th></th></tr></thead><tbody>{visibleStudents.map((student) => <tr key={student.id}><td><div className="student-cell"><span className="student-avatar">{initials(student.name)}</span><span><b>{student.name}</b><small>{student.parentName || 'Parent not added'}</small></span></div></td><td>{student.registerNumber}</td><td>{student.department} · {student.year}-{student.section}</td><td>{student.parentWhatsApp || '—'}</td><td>{student.parentWhatsAppConsent ? 'Consented' : 'Not consented'}</td><td>{student.email || '—'}</td><td><div className="student-actions">{isAdmin && <button className="text-button" onClick={() => { changeKind('student'); setEditId(student.id); setValues({ name: student.name, registerNumber: student.registerNumber, rollNumber: student.rollNumber, classId: String(student.classId), parentName: student.parentName || '', parentWhatsApp: student.parentWhatsApp || '', parentWhatsAppConsent: student.parentWhatsAppConsent, email: student.email || '', photoUrl: student.photoUrl || '' }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Edit</button>}<button className="delete-student" onClick={() => removeRecord('student', student)} aria-label={`Delete ${student.name}`}>Delete</button></div></td></tr>)}</tbody></table></div> : <div className="empty-state"><span className="empty-icon"><Users size={20} /></span><b>{data ? 'No students in the directory yet' : 'Loading college configuration…'}</b><p>{isAdmin ? 'Add students above once you have created their class.' : 'No active students are assigned to your department.'}</p></div>}
    </section>
  </>;
}

function HodAssignmentForm({ token, data, onToast }) {
  const [values, setValues] = useState({ classId: '', subjectId: '', facultyId: '', periodId: '', dayOfWeek: '1' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const body = Object.fromEntries(Object.entries(values).map(([field, value]) => [field, Number(value)]));
      await api(token, '/admin/setup', { method: 'POST', body: { type: 'assignment', ...body } });
      onToast('Faculty period assigned successfully.');
      setValues({ classId: '', subjectId: '', facultyId: '', periodId: '', dayOfWeek: '1' });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  const classOptions = data?.classes || [];
  const subjectOptions = data?.subjects || [];
  const facultyOptions = data?.faculty || [];
  const periodOptions = data?.periods || [];
  const hasOptions = classOptions.length && subjectOptions.length && facultyOptions.length && periodOptions.length;

  return <section className="panel hod-assignment-panel">
    <div className="setup-panel-heading"><span className="filter-icon"><BookOpen size={17} /></span><div><h2>Assign faculty to a class period</h2><p>Choose the class, subject, faculty member, period, and day, then assign in one step.</p></div></div>
    {!hasOptions ? <div className="empty-state"><b>Timetable setup is not ready</b><p>An administrator must add classes, subjects, faculty, and periods before you can assign a timetable slot.</p></div> : <form className="hod-assignment-form" onSubmit={submit}>
      <label className="setup-field"><span>Class</span><select required value={values.classId} onChange={(event) => setValues({ ...values, classId: event.target.value })}><option value="">Choose class</option>{classOptions.map((item) => <option key={item.id} value={item.id}>{item.department} · {item.year}-{item.section}</option>)}</select></label>
      <label className="setup-field"><span>Subject</span><select required value={values.subjectId} onChange={(event) => setValues({ ...values, subjectId: event.target.value })}><option value="">Choose subject</option>{subjectOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="setup-field"><span>Faculty</span><select required value={values.facultyId} onChange={(event) => setValues({ ...values, facultyId: event.target.value })}><option value="">Choose faculty</option>{facultyOptions.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.facultyCode}</option>)}</select></label>
      <label className="setup-field"><span>Period</span><select required value={values.periodId} onChange={(event) => setValues({ ...values, periodId: event.target.value })}><option value="">Choose period</option>{periodOptions.map((item) => <option key={item.id} value={item.id}>Period {item.periodNumber}</option>)}</select></label>
      <label className="setup-field"><span>Day</span><select required value={values.dayOfWeek} onChange={(event) => setValues({ ...values, dayOfWeek: event.target.value })}>{['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select></label>
      {error && <div className="form-error setup-error" role="alert">{error}</div>}
      <div className="setup-form-footer"><span><ShieldCheck size={14} /> Assignments are restricted to your department.</span><button className="button button-primary" disabled={loading}>{loading ? 'Assigning…' : 'Assign period'} <ArrowRight size={15} /></button></div>
    </form>}
  </section>;
}

function ManagementDirectory({ title, records, type, onDelete, emptyMessage }) {
  return <section className="panel management-directory">
    <div className="roster-toolbar"><div><h2>{title}</h2><p>{records.length} records</p></div></div>
    {records.length ? <div className="management-record-list">{records.map((record) => <div className="management-record" key={record.id}>
      <div><b>{record.label}</b><small>{record.detail}</small></div>
      <button className="delete-student" onClick={() => onDelete(type, record)} aria-label={`Delete ${record.label}`}><Trash2 size={14} /> Delete</button>
    </div>)}</div> : <div className="empty-state"><b>{emptyMessage}</b></div>}
  </section>;
}

function Reports({ token }) {
  const [start, setStart] = useState(() => `${today().slice(0, 7)}-01`);
  const [end, setEnd] = useState(today());
  const [records, setRecords] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const result = await api(token, `/reports/attendance?start=${start}&end=${end}`);
      setRecords(result.records);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [token]);

  function exportCsv() {
    const headers = ['Date', 'Student', 'Register number', 'Department', 'Year', 'Section', 'Period', 'Subject', 'Faculty', 'Status'];
    const rows = records.map((record) => [record.date, record.student, record.registerNumber, record.department, record.year, record.section, record.period, record.subject, record.faculty, record.status]);
    const csv = [headers, ...rows].map((row) => row.map((field) => `"${String(field ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `attendance-${start}-to-${end}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return <>
    <PageHeading eyebrow="INSIGHTS & RECORDS" title="Attendance reports" description="Review period-wise attendance and export a detailed report." action={<button className="button button-secondary" onClick={exportCsv} disabled={!records.length}><ArrowDownToLine size={16} /> Export CSV</button>} />
    <section className="panel report-filter"><div className="report-filter-title"><span className="filter-icon"><SlidersHorizontal size={17} /></span><div><h2>Filter report</h2><p>Choose the date range for your report</p></div></div><div className="filter-fields"><label className="date-filter">FROM<input type="date" value={start} max={end} onChange={(event) => setStart(event.target.value)} /></label><label className="date-filter">TO<input type="date" value={end} min={start} max={today()} onChange={(event) => setEnd(event.target.value)} /></label><button className="button button-primary" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Apply filters'}</button></div></section>
    {error && <div className="notice-error" role="alert">{error}</div>}
    <section className="panel recent-panel report-panel"><div className="panel-heading"><div><h2>Attendance records</h2><p>{records.length} records · {showDate(start)} — {showDate(end)}</p></div><span className="panel-tag"><FileSpreadsheet size={14} /> CSV READY</span></div>
      {records.length ? <div className="table-scroll"><table><thead><tr><th>DATE</th><th>STUDENT</th><th>DEPARTMENT / CLASS</th><th>PERIOD</th><th>SUBJECT</th><th>FACULTY</th><th>STATUS</th></tr></thead><tbody>{records.map((record, index) => <tr key={`${record.date}-${record.registerNumber}-${record.period}-${index}`}><td>{showDate(record.date)}</td><td><div className="student-cell"><span className="student-avatar">{initials(record.student)}</span><span><b>{record.student}</b><small>{record.registerNumber}</small></span></div></td><td>{record.department} · {record.year}-{record.section}</td><td><span className="period-pill">P{record.period}</span></td><td>{record.subject}</td><td>{record.faculty}</td><td><span className={`attendance-badge ${record.status}`}>{record.status}</span></td></tr>)}</tbody></table></div> : <div className="empty-state"><span className="empty-icon"><FileSpreadsheet size={20} /></span><b>{loading ? 'Loading report…' : 'No attendance records found'}</b><p>Try adjusting the date range or check back after attendance is submitted.</p></div>}
    </section>
    <div className="report-note"><CircleHelp size={15} /> For PDF exports, open your browser's print dialog and choose “Save as PDF”.</div>
  </>;
}

function Notifications({ token, user, onToast }) {
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState({ total: 0, pending: 0, sent: 0, delivered: 0, failed: 0 });
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState('');
  const load = useCallback(() => api(token, '/notifications')
    .then((result) => { setItems(result.notifications); setSummary(result.summary); setError(''); })
    .catch((requestError) => setError(requestError.message)), [token]);
  useEffect(() => { load(); }, [load]);

  async function retry(id) {
    setRetrying(String(id));
    try {
      await api(token, `/notifications/${id}/retry`, { method: 'POST' });
      await load();
      onToast('Notification retry completed.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setRetrying('');
    }
  }

  const canRetry = user.role === 'admin' || user.role === 'hod';
  return <>
    <PageHeading eyebrow="COMMUNICATION LOG" title="Notifications" description="Track WhatsApp absence alerts sent to consented parent and guardian contacts." action={<button className="button button-secondary" onClick={load}><Activity size={16} /> Refresh</button>} />
    <div className="notification-stats">
      {[
        ['Total absence alerts', summary.total, 'blue', Activity],
        ['Pending', summary.pending, 'purple', Clock3],
        ['Sent', summary.sent, 'green', CheckCircle2],
        ['Delivered', summary.delivered, 'green', CheckCircle2],
        ['Failed', summary.failed, 'coral', Bell],
      ].map(([label, count, tint, Icon]) => <div className="notification-stat" key={label}><span className={`notification-stat-icon ${tint}`}><Icon size={18} /></span><span><b>{count || 0}</b><small>{label}</small></span></div>)}
    </div>
    {error && <div className="notice-error" role="alert">{error}</div>}
    <section className="panel recent-panel notification-panel"><div className="panel-heading"><div><h2>Notification history</h2><p>Parent/guardian delivery attempts, newest first</p></div><span className="panel-tag"><span className="live-dot" /> LIVE STATUS</span></div>
      {items.length ? <div className="table-scroll"><table><thead><tr><th>STUDENT</th><th>REGISTER NUMBER</th><th>PARENT WHATSAPP</th><th>PERIOD</th><th>ATTENDANCE DATE</th><th>ATTEMPTS</th><th>STATUS</th><th></th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.student}</td><td>{item.registerNumber}</td><td>{item.recipientNumber}</td><td><span className="period-pill">P{item.period}</span></td><td>{showDate(item.attendanceDate)}</td><td>{item.attempts}</td><td><NotificationStatus status={item.status} error={item.errorMessage} /></td><td>{item.status === 'failed' && canRetry && <button className="retry-button" disabled={retrying === String(item.id)} onClick={() => retry(item.id)}>{retrying === String(item.id) ? 'Retrying…' : 'Retry'}</button>}</td></tr>)}</tbody></table></div> : <div className="empty-state"><span className="empty-icon"><Bell size={20} /></span><b>No notifications yet</b><p>WhatsApp absence alerts for consented parent contacts will appear here.</p></div>}
    </section>
  </>;
}

function NotificationStatus({ status, error }) {
  const labels = { delivered: 'Delivered', sent: 'Sent', failed: 'Failed', pending: 'Pending', sending: 'Sending', corrected: 'Corrected' };
  return <span className="status-with-error"><span className={`notification-status ${status}`}><i />{labels[status] || status}</span>{status === 'failed' && error && <small className="status-error" title={error}>{error}</small>}</span>;
}

export default App;
