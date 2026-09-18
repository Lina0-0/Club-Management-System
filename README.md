# Club-Management-System
 A full-stack club management system for the Catalyst Chemistry Club — built with Node.js, Express, PostgreSQL, and vanilla JavaScript.

A full-stack web application for managing a university chemistry club — handling memberships, roles, requests, events, posts, and communication between students, instructors, managers, and club leadership.

## Features

### Authentication
- Secure login with bcrypt password hashing
- Forgot/reset password flow with tokenized links and email delivery
- Role-based access control (student, member, instructor, manager, vice-president, president)

### Membership & Roles
- Join request form with validation (username, ID, email, motivation, skills)
- Manager approval workflow with auto-generated account credentials sent via email
- Withdraw requests (member & position)
- Nomination requests for leadership positions
- Department & sub-department assignment

### Department System (Managers)
- View and search department members
- Add, modify, or remove members/instructors
- Enforce "one instructor per sub-department" rule
- Automatic notifications on role changes

### Club System (President / VP)
- View all club members with roles and departments
- Add / modify / remove managers
- Appoint or replace Vice President
- Transfer presidency or resign

### Posts & Communication
- Share posts (Event / Workshop / Informative) with optional images
- Notifications sent to relevant recipients (department, sub-department, or whole club)
- Reply system for incoming requests (approve/reject with details)
- Email notifications for join-request outcomes

### Notifications
- Unread badges for requests and notifications
- Mark as seen / clear all
- Auto-refresh every 30 seconds

### Public Explore Page
- Guest browsing for events, workshops, and announcements
- Image slider and department showcase

## Tech Stack

**Backend**
- Node.js + Express
- PostgreSQL (`pg`)
- bcrypt, multer, nodemailer, cors, dotenv

**Frontend**
- Vanilla HTML/CSS/JavaScript
- Tailwind CSS (CDN) for some pages
- Font Awesome icons
