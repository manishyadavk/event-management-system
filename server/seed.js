import { db } from './db.js';
import { hashPassword } from './auth.js';
import { todayStr } from './services.js';

// Seeds sample data once. Event dates are relative to today so "upcoming"/"this month" queries always have data.
// All demo students share one password (DEMO_STUDENT_PASSWORD, default below) - demo data only.
export function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) c FROM events').get().c > 0) return false;

  const d = (offset) => { const x = new Date(); x.setDate(x.getDate() + offset); return todayStr(x); };
  const pw = hashPassword(process.env.DEMO_STUDENT_PASSWORD || 'Student@123');

  const students = [
    ['Aarav Sharma', 'aarav.sharma@example.com', 'B.Tech CSE'],
    ['Priya Verma', 'priya.verma@example.com', 'BBA'],
    ['Rohan Gupta', 'rohan.gupta@example.com', 'B.Tech IT'],
    ['Sneha Iyer', 'sneha.iyer@example.com', 'BCA'],
    ['Karan Mehta', 'karan.mehta@example.com', 'MBA'],
    ['Ananya Reddy', 'ananya.reddy@example.com', 'B.Tech CSE'],
    ['Vikram Singh', 'vikram.singh@example.com', 'B.Sc Data Science'],
    ['Meera Nair', 'meera.nair@example.com', 'BCA'],
  ];
  const insS = db.prepare('INSERT INTO students (name,email,course,password_hash) VALUES (?,?,?,?)');
  students.forEach((s) => insS.run(...s, pw));

  const events = [
    ['AI & Machine Learning Workshop', 'Hands-on introduction to supervised learning: build and evaluate your first classifier with scikit-learn.', 'AI', d(2), '10:00', 'Computer Lab 1', 40],
    ['Business Analytics Workshop', 'Dashboards, KPIs and data storytelling with Excel and Power BI.', 'Business', d(4), '14:00', 'Computer Lab 2', 30],
    ['Web Development Seminar', 'Modern web stack tour: HTML/CSS, JavaScript frameworks, APIs and deployment.', 'Web Development', d(6), '11:00', 'Seminar Hall A', 80],
    ['Entrepreneurship Seminar', 'Founders share how they validated ideas, raised funds and built their first teams.', 'Entrepreneurship', d(9), '15:00', 'Auditorium', 120],
    ['Cybersecurity Workshop', 'Practical session on web vulnerabilities, password hygiene and ethical hacking basics.', 'Cybersecurity', d(12), '10:30', 'Computer Lab 3', 6],
    ['Data Science Workshop', 'End-to-end data science: cleaning, visualisation and modelling with Python and pandas.', 'Data Science', d(16), '13:00', 'Seminar Hall B', 50],
    ['Prompt Engineering for Machine Learning Engineers', 'Designing prompts, evaluating LLM outputs and building tool-using AI agents.', 'Machine Learning', d(21), '10:00', 'Computer Lab 1', 25],
    ['Cloud & DevOps Technology Talk', 'How teams ship software: containers, CI/CD pipelines and cloud basics.', 'Technology', d(27), '16:00', 'Auditorium', 100],
    ['Generative AI Hackathon Kickoff', 'Team formation and problem statements for the campus generative-AI hackathon.', 'AI', d(35), '09:30', 'Innovation Center', 60],
    ['Career Readiness Seminar', 'Resume building, interview skills and campus placement tips (past event).', 'Business', d(-10), '11:00', 'Auditorium', 120],
  ];
  const insE = db.prepare('INSERT INTO events (name,description,category,date,time,venue,max_capacity) VALUES (?,?,?,?,?,?,?)');
  events.forEach((e) => insE.run(...e));

  const insR = db.prepare(`INSERT INTO registrations (student_id,event_id,registration_date,status,calendar_status) VALUES (?,?,?,?,?)`);
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  // Cybersecurity (event 5, capacity 6) is deliberately full so the "Event Full" path can be demonstrated.
  const regs = [[1, 1, 5], [1, 3, 4], [2, 1, 4], [2, 2, 3], [3, 2, 3], [4, 3, 2], [5, 1, 2], [5, 4, 2], [6, 1, 1], [7, 6, 1],
    [1, 5, 6], [2, 5, 5], [3, 5, 5], [4, 5, 4], [6, 5, 3], [7, 5, 2], [8, 3, 1], [8, 10, 12]];
  regs.forEach(([s, e, a]) => insR.run(s, e, ago(a), 'confirmed', 'pending'));
  return true;
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  console.log(seedIfEmpty() ? 'Seeded sample data.' : 'Database already has data.');
}
