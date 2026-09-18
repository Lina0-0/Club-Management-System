const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
require('dotenv').config();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

const nodemailer = require('nodemailer');

const emailTransporter = nodemailer.createTransport({
    service: 'gmail', 
    auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS  
    }
});

emailTransporter.verify((error, success) => {
    if (error) {
        console.error('❌ Email configuration error:', error);
    } else {
        console.log('✅ Email service ready to send messages');
    }
});

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/uploads/')
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Only images are allowed'));
    }
});

function countWords(text) {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

pool.connect((err) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
    } else {
        console.log('✅ Connected to PostgreSQL database');
    }
});

async function getRecipientsForManagerPost(managerId, departmentName) {
    try {
        const managerDeptResult = await pool.query(
            `SELECT m."DepartmentID", d."Department_name"
             FROM "Manager" m
             JOIN "Department" d ON m."DepartmentID" = d."DepartmentID"
             WHERE m."UserID" = $1`,
            [managerId]
        );
        
        if (managerDeptResult.rows.length === 0) {
            console.log(`Manager ${managerId} not found`);
            return [];
        }
        
        const departmentId = managerDeptResult.rows[0].DepartmentID;
        const actualDepartmentName = managerDeptResult.rows[0].Department_name;
        
        console.log(`Manager ${managerId} manages: ${actualDepartmentName} (ID: ${departmentId})`);

        const result = await pool.query(
            `SELECT DISTINCT m."UserID"
             FROM "Member" m
             JOIN "Sub_department" sd ON m."Sub_departmentID" = sd."Sub_departmentID"
             WHERE sd."DepartmentID" = $1
               AND m."UserID" != $2`,
            [departmentId, managerId]
        );
        
        console.log(`Found ${result.rows.length} members in department ${actualDepartmentName}`);
        return result.rows.map(row => row.UserID);
    } catch (error) {
        console.error('Error getting manager recipients:', error);
        return [];
    }
}

async function getPresidentIds() {
    try {
        const result = await pool.query(
            `SELECT "UserID" FROM "President"`
        );
        return result.rows.map(row => row.UserID);
    } catch (error) {
        console.error('Error getting president IDs:', error);
        return [];
    }
}

async function getRecipientsForInstructorPost(instructorId, subDepartmentName) {
    try {
        
        const subDeptResult = await pool.query(
            `SELECT "Sub_departmentID" FROM "Sub_department" 
             WHERE "Sub_department_name" = $1`,
            [subDepartmentName]
        );
        
        if (subDeptResult.rows.length === 0) {
            console.log(`Sub-department not found: ${subDepartmentName}`);
            return [];
        }
        
        const subDepartmentId = subDeptResult.rows[0].Sub_departmentID;

        const instructorCheck = await pool.query(
            `SELECT "UserID" FROM "Instructor" 
             WHERE "UserID" = $1 AND "Sub_departmentID" = $2`,
            [instructorId, subDepartmentId]
        );
        
        if (instructorCheck.rows.length === 0) {
            console.log(`User ${instructorId} is not an instructor for sub-department ID ${subDepartmentId}`);
            return [];
        }

        const result = await pool.query(
            `SELECT m."UserID"
             FROM "Member" m
             WHERE m."Sub_departmentID" = $1
               AND m."UserID" != $2`,
            [subDepartmentId, instructorId]
        );
        
        console.log(`Found ${result.rows.length} members in sub-department ${subDepartmentName}`);
        return result.rows.map(row => row.UserID);
    } 
    catch (error) {
        console.error('Error getting instructor recipients:', error);
        return [];
    }
}

async function createPostNotifications(postId, posterId, posterName, postTitle, recipients, contextInfo) {
    if (!recipients || recipients.length === 0) {
        console.log(`No recipients to notify for post ${postId}`);
        return;
    }
    
    const details = `${posterName} posted in ${contextInfo}: ${postTitle.substring(0, 100)}${postTitle.length > 100 ? '...' : ''}`;

    for (const recipientId of recipients) {
        await pool.query(
            `INSERT INTO "Notification" (
                "Details_notification", 
                "Type_notification", 
                "Status_notification", 
                "Sender", 
                "UserID",
                "PostID",
                "Time"
            ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
            [
                details,
                'New Post',
                'Unread',
                posterName,
                recipientId,
                postId
            ]
        );
    }
    
    console.log(`Created ${recipients.length} post notifications for post ${postId}`);
}

async function getManagerDepartment(managerId) {
    const result = await pool.query(
        `SELECT "DepartmentID" FROM "Manager" WHERE "UserID" = $1`,
        [managerId]
    );
    return result.rows.length > 0 ? result.rows[0].DepartmentID : null;
}

async function getSubDepartmentsByDepartment(departmentId) {
    const result = await pool.query(
        `SELECT "Sub_departmentID", "Sub_department_name" 
         FROM "Sub_department" 
         WHERE "DepartmentID" = $1
         ORDER BY "Sub_department_name"`,
        [departmentId]
    );
    return result.rows;
}

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    
    const formattedUsername = username.startsWith('@') ? username : `@${username}`;
    
    try {
        const result = await pool.query(
            'SELECT "UserID", "Username", "Password", "Email", "Faculty_name", "Level", "Role", "DepartmentID" FROM "Users" WHERE "Username" = $1',
            [formattedUsername]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid username or password' });
        }
        
        const user = result.rows[0];

        if (user.Role === 'none') {
            return res.status(403).json({ 
                success: false, 
                message: 'Your account has been deactivated. Please contact the club leadership for more information.' 
            });
        }
        
        const validPassword = await bcrypt.compare(password, user.Password);
        
        if (!validPassword) {
            return res.status(401).json({ success: false, message: 'Invalid username or password' });
        }
        
        res.json({
            success: true,
            message: 'Login successful',
            user: {
                id: user.UserID,
                username: user.Username,
                email: user.Email,
                faculty: user.Faculty_name,
                level: user.Level,
                role: user.Role,
                DepartmentID: user.DepartmentID || 0
            }
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Server error during login' });
    }
});

app.post('/api/submit-join-request', async (req, res) => {
    
    try {
        const { 
            username, 
            ID, 
            email, 
            motivationReason, 
            skills, 
            motivation,
            subdepartment,
            Experience,
            facultyName,
            Level
        } = req.body;

        if (!email || !email.includes('@')) {
            return res.status(400).json({ 
                success: false, 
                message: 'Please enter a valid email address.' 
            });
        }
        
        const idNumberRegex = /^(202[0-5])\d{8}$/;
        if (!ID || !idNumberRegex.test(ID)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid ID number (format: 202xxxxxx)' 
            });
        }
        
        const usernameRegex = /^@[A-Za-z]{8,}$/;
        if (!username || !usernameRegex.test(username)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Username must be at least 8 letters (no numbers)' 
            });
        }
        
        const wordCount = countWords(motivationReason);
        if (!motivationReason || wordCount < 10) {
            return res.status(400).json({ 
                success: false, 
                message: `Motivation reason must be at least 10 words. Currently: ${wordCount} words` 
            });
        }
        
        if (!skills || skills.length < 50 || skills.length > 1000) {
            return res.status(400).json({ 
                success: false, 
                message: 'Skills must be between 50 and 1000 characters.' 
            });
        }
        
        if (!facultyName || facultyName.trim().length < 3) {
            return res.status(400).json({ 
                success: false, 
                message: 'Please enter a valid faculty name (at least 3 characters).' 
            });
        }
        
        if (!Level || Level.trim().length < 2) {
            return res.status(400).json({ 
                success: false, 
                message: 'Please enter your level (e.g., L1, L2, M1, L3, etc.).' 
            });
        }
        
        const existingUserById = await pool.query(
            'SELECT "UserID", "Role", "Username" FROM "Users" WHERE "UserID" = $1',
            [ID]
        );
        
        if (existingUserById.rows.length > 0) {
            const user = existingUserById.rows[0];
            if (user.Role === 'none') {
                console.log(`✅ User ${ID} has deactivated account, allowing join request`);
                
            } else {
                
                return res.status(400).json({ 
                    success: false, 
                    message: 'You already have an active account. Please login instead.' 
                });
            }
        }
        
        const formattedUsername = username;
        const existingUserByUsername = await pool.query(
            'SELECT "Username", "Role" FROM "Users" WHERE "Username" = $1',
            [username]
        );
        
        if (existingUserByUsername.rows.length > 0) {
            const user = existingUserByUsername.rows[0];
            
            if (user.Role !== 'none') {
                return res.status(400).json({ 
                    success: false, 
                    message: 'This username is already taken. Please choose another one.' 
                });
            }
        }
        
        const existingUserByEmail = await pool.query(
            'SELECT "Email", "Role" FROM "Users" WHERE "Email" = $1',
            [email]
        );
        
        if (existingUserByEmail.rows.length > 0) {
            const user = existingUserByEmail.rows[0];
            
            if (user.Role !== 'none') {
                return res.status(400).json({ 
                    success: false, 
                    message: 'This email is already registered. Please use a different email.' 
                });
            }
        }
        
        const existingRequest = await pool.query(
            `SELECT "RequestID" FROM "Request" 
             WHERE "Details_request" LIKE $1 
             AND "Status_request" = 'Pending'`,
            [`%Registration Number: ${ID}%`]
        );
        
        if (existingRequest.rows.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'You already have a pending join request. Please wait for the manager to respond.' 
            });
        }
        
        const managerQuery = await pool.query(
            `SELECT m."UserID" 
             FROM "Manager" m
             JOIN "Sub_department" s ON m."DepartmentID" = s."DepartmentID"
             WHERE s."Sub_department_name" = $1`,
            [subdepartment]
        );
        
        const receiverID = managerQuery.rows.length > 0 ? managerQuery.rows[0].UserID : null;
        
        if (!receiverID) {
            return res.status(404).json({ 
                success: false, 
                message: 'No manager found for this department.' 
            });
        }
        
        let rejoiningNote = '';
        if (existingUserById.rows.length > 0 && existingUserById.rows[0].Role === 'none') {
            rejoiningNote = '\n⚠️ NOTE: This user had a deactivated account and is requesting to rejoin.\n';
        }
        
        const Details_request = `📋 NEW JOIN REQUEST${rejoiningNote}

        Username: ${username}
        Registration Number: ${ID}
        Email: ${email}
        Faculty: ${facultyName}
        Level: ${Level}
        Requested Sub-department: ${subdepartment}
        Motivation: ${motivationReason}
        Skills: ${skills}
        How they heard: ${motivation}
        Previous Experience: ${Experience}`;
        
        await pool.query(
            `INSERT INTO "Notification" (
                "Details_notification", 
                "Type_notification", 
                "Status_notification", 
                "Sender", 
                "UserID",
                "Time"
            ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
            [
                Details_request,
                'Join Request',
                'Unread',
                username,
                receiverID
            ]
        );
        
        return res.json({ 
            success: true, 
            message: 'Join request sent to the manager! They will review your application.' 
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: 'Server error: ' + error.message 
        });
    }
});

async function sendApprovalEmail(email, username, password, userId) {
    const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0b1421; color: #fff; border-radius: 10px;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: #00d4ff;">Catalyst Chemistry Club</h2>
                <p style="color: #94a3b8;">University of Boumerdes</p>
            </div>
            <div style="background: #111d2b; padding: 20px; border-radius: 10px; border-left: 4px solid #4ecb71;">
                <h3 style="color: #4ecb71; margin: 0 0 10px 0;">✅ Join Request Approved!</h3>
                <p style="color: #fff; margin: 10px 0;"><strong>Your account has been created:</strong></p>
                <div style="background: #0f172a; padding: 12px; border-radius: 8px; margin-top: 15px;">
                    <p style="color: #fff; margin: 5px 0;">
                        <strong>Username:</strong> <span style="color: #00d4ff;">${username}</span>
                    </p>
                    <p style="color: #fff; margin: 5px 0;">
                        <strong>Password:</strong> <span style="color: #ffa500;">${password}</span>
                    </p>
                    <p style="color: #fff; margin: 5px 0;">
                        <strong>Registration Number:</strong> <span style="color: #00d4ff;">${userId}</span>
                    </p>
                </div>
                <div style="background: #0f172a; padding: 12px; border-radius: 8px; margin-top: 15px;">
                    <p style="color: #ffa500; margin: 0 0 10px 0;">
                        📝 Next Steps:
                    </p>
                    <p style="color: #fff; margin: 5px 0; font-size: 14px;">
                        1. The manager will add you to a department<br>
                        2. Once added, you can log in with the credentials above<br>
                        3. Change your password after first login
                    </p>
                </div>
                <hr style="border-color: #2d3748; margin: 15px 0;">
                <p style="color: #94a3b8; font-size: 12px; text-align: center;">
                    Login at: <a href="http://localhost:3000" style="color: #00d4ff;">http://localhost:3000</a>
                </p>
            </div>
        </div>
    `;
    
    await emailTransporter.sendMail({
        from: `"Catalyst Club" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: `Catalyst Club - Your Account Has Been Created`,
        html: emailHtml,
        text: `Your account has been created!\n\nUsername: ${username}\nPassword: ${password}\nRegistration Number: ${userId}\n\nLogin at: http://localhost:3000`
    });
}

app.get('/api/club/check-vice-president', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u."UserID", u."Username" 
             FROM "Vice_President" vp
             JOIN "Users" u ON vp."UserID" = u."UserID"
             WHERE vp."ClubID" = 1`
        );
        
        if (result.rows.length > 0) {
            res.json({ 
                success: true, 
                hasVP: true, 
                vpId: result.rows[0].UserID,
                vpUsername: result.rows[0].Username
            });
        } else {
            res.json({ success: true, hasVP: false });
        }
    } catch (error) {
        console.error('Error checking VP:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/department/add-member-direct', async (req, res) => {
    const { managerId, userId, username, faculty, level, role, subDepartmentName } = req.body;
    
    try {

        const departmentId = await getManagerDepartment(managerId);
        if (!departmentId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        const subDeptResult = await pool.query(
            `SELECT "Sub_departmentID", "Sub_department_name"
             FROM "Sub_department"
             WHERE "DepartmentID" = $1 AND "Sub_department_name" = $2`,
            [departmentId, subDepartmentName]
        );
        
        if (subDeptResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid sub-department' });
        }
        
        const subDepartmentId = subDeptResult.rows[0].Sub_departmentID;
        
        let existingUser = await pool.query(
            `SELECT "UserID", "Username" FROM "Users" WHERE "UserID" = $1`,
            [userId]
        );
        
        if (existingUser.rows.length === 0) {
            const defaultPassword = await bcrypt.hash('default123', 10);
            
            await pool.query(
                `INSERT INTO "Users" ("UserID", "Username", "Password", "Faculty_name", "Level", "Role", "DepartmentID")
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [userId, username, defaultPassword, faculty, level, role, departmentId]
            );
        } else {
            await pool.query(
                `UPDATE "Users" SET 
                    "Username" = $1,  
                    "Faculty_name" = $2, 
                    "Level" = $3, 
                    "Role" = $4, 
                    "DepartmentID" = $5
                 WHERE "UserID" = $6`,
                [username, faculty, level, role, departmentId, userId]
            );
        }
        
        const existingMember = await pool.query(
            `SELECT "UserID" FROM "Member" WHERE "UserID" = $1`,
            [userId]
        );
        
        if (existingMember.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'User is already a member' });
        }
        
        if (role === 'instructor') {
            const existingInstructor = await pool.query(
                `SELECT i."UserID" FROM "Instructor" i
                 WHERE i."Sub_departmentID" = $1`,
                [subDepartmentId]
            );
            
            if (existingInstructor.rows.length > 0) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'This sub-department already has an instructor' 
                });
            }
        }
        
        await pool.query(
            `INSERT INTO "Member" ("UserID", "Membership_date", "Sub_departmentID")
             VALUES ($1, CURRENT_DATE, $2)`,
            [userId, subDepartmentId]
        );
        
        if (role === 'instructor') {
            await pool.query(
                `INSERT INTO "Instructor" ("UserID", "Sub_departmentID")
                 VALUES ($1, $2)`,
                [userId, subDepartmentId]
            );
        }
        
        const managerInfo = await pool.query(
            'SELECT "Username" FROM "Users" WHERE "UserID" = $1',
            [managerId]
        );
        const managerName = managerInfo.rows[0]?.Username || 'A manager';
        
        const notificationMessage = role === 'instructor' 
            ? `${managerName} has added you as an INSTRUCTOR for ${subDepartmentName} sub-department.`
            : `${managerName} has added you as a MEMBER of ${subDepartmentName} sub-department.`;
        
        await pool.query(
            `INSERT INTO "Notification" ("Details_notification", "Type_notification", "Status_notification", "Sender", "UserID", "Time")
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
            [notificationMessage, 'Role Assignment', 'Unread', managerName, userId]
        );
        
        res.json({ success: true, message: `${role} added successfully!` });
        
    } catch (error) {
        console.error('Error adding member:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

app.post('/api/submit-withdraw-request', async (req, res) => {
    const { 
        fullname, 
        ID, 
        subdepartment,
        withdrawReason
    } = req.body;
    
    if (!withdrawReason) {
        return res.status(400).json({ 
            success: false, 
            message: 'Withdraw reason is required' 
        });
    }
    
    const withdrawWordCount = countWords(withdrawReason);
    if (withdrawWordCount < 10) {
        return res.status(400).json({ 
            success: false, 
            message: `Withdraw reason must be at least 10 words (currently ${withdrawWordCount} words)` 
        });
    }

    const numericID = Number(ID);
    const Type_request = "Member Withdraw request";
    const Details_request = `User name: ${fullname}.<br>Sub-department: ${subdepartment}.<br>Withdraw reason: ${withdrawReason}`;
    const Status_request = "Pending";

    try {
        const userCheck = await pool.query(
            'SELECT "UserID", "Username" FROM "Users" WHERE "UserID" = $1 AND "Username" = $2',
            [numericID, fullname]
        );
        
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Invalid Username or Registration Number' 
            });
        }

        const managerQuery = await pool.query(
            `SELECT m."UserID" 
             FROM "Manager" m
             JOIN "Sub_department" s ON m."DepartmentID" = s."DepartmentID"
             WHERE s."Sub_department_name" = $1`,
            [subdepartment]
        );
        
        const receiverID = managerQuery.rows.length > 0 ? managerQuery.rows[0].UserID : null;

        const requestResult = await pool.query(
            `INSERT INTO "Request" ("Type_request", "Details_request", "Status_request", "UserID", "Created_at")
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            RETURNING "RequestID"`,
            [Type_request, Details_request, Status_request, numericID]
        );

        const newRequestId = requestResult.rows[0].RequestID;

        if (receiverID) {
            await pool.query(
                `INSERT INTO "Notification" ("Details_notification", "Type_notification", "Status_notification", "Sender", "UserID", "RequestID", "Time")
                VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
                [
                    Details_request,
                    'Withdraw Request',
                    'Unread',
                    fullname,
                    receiverID,
                    newRequestId
                ]
            );
        }

        res.json({ 
            success: true, 
            message: 'Withdraw request submitted.' 
        });
        
    } catch (error) {
        console.error('Database error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error while checking user' 
        });
    }
});

app.post('/api/submit-withdraw-position-request', async (req, res) => {
    const { 
        intendedRole,
        fullname1, ID1, 
        fullname2, ID2, 
        withdrawPositionReason, 
        recommendationReason,
        department,
        subdepartment
    } = req.body;

    const withdrawWordCount = countWords(withdrawPositionReason);
    const recommendationWordCount = countWords(recommendationReason);

    if (withdrawWordCount < 10 || recommendationWordCount < 10) {
        return res.status(400).json({ 
            success: false, 
            message: 'Both reasons must be at least 10 words.' 
        });
    }

    const numericID1 = Number(ID1);
    const numericID2 = Number(ID2);
    const Type_request = "Withdraw request";
    const Details_request = `User name : ${fullname1}.<br>Replacement User name: ${fullname2}.<br>Registration number: ${numericID2}.<br>Department: ${department}.<br>Sub-department: ${subdepartment}.<br>Withdraw reason: ${withdrawPositionReason}.<br>Recommendation reason: ${recommendationReason}`;
    const Status_request = "Pending";

    try {
        const userCheck = await pool.query(
            'SELECT "UserID", "Username", "Role" FROM "Users" WHERE "UserID" = $1 AND "Username" ILIKE $2',
            [numericID1, fullname1.trim()]
        );
        
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Invalid Username or ID for resignation.' });
        }

        const rawRole = userCheck.rows[0].Role || ''; 
        const resigningRole = rawRole.toLowerCase().trim();

        const userCheck2 = await pool.query(
            'SELECT "UserID" FROM "Users" WHERE "UserID" = $1 AND "Username" ILIKE $2',
            [numericID2, fullname2.trim()]
        );
        
        if (userCheck2.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'The recommended replacement user does not exist.' });
        }
        
        if (resigningRole !== intendedRole.toLowerCase().trim()) {
            return res.status(403).json({ 
                success: false, 
                message: `Access Denied. This form is for ${intendedRole}s, but you are registered as a ${resigningRole}.` 
            });
        }
        
        let receiverIDs = [];

        if (resigningRole === 'instructor') {
            const managerQuery = await pool.query(
                `SELECT "UserID" FROM "Manager" 
                 WHERE "DepartmentID" = (
                    SELECT "DepartmentID" FROM "Department" 
                    WHERE "Department_name" ILIKE $1 
                 )`,
                [`%${department.trim()}%`]
            );
            receiverIDs = managerQuery.rows.map(r => r.UserID);
        } 
        else if (resigningRole === 'manager') {
            const adminQuery = await pool.query(
                `SELECT "UserID" FROM "President" 
                 UNION 
                 SELECT "UserID" FROM "Vice_President"`
            );
            receiverIDs = adminQuery.rows.map(r => r.UserID);
        }

        
        const requestResult = await pool.query(
            `INSERT INTO "Request" ("Type_request", "Details_request", "Status_request", "UserID", "Created_at")
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            RETURNING "RequestID"`,
            [Type_request, Details_request, Status_request, numericID1]  
        );

        const newRequestId = requestResult.rows[0].RequestID;

        if (receiverIDs.length > 0) {
            const notificationPromises = receiverIDs.map(id => {
                return pool.query(
                    `INSERT INTO "Notification" (
                        "Details_notification", 
                        "Type_notification", 
                        "Status_notification", 
                        "Sender", 
                        "UserID",
                        "RequestID",
                        "Time"
                    ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,  
                    [
                        Details_request,
                        'Withdraw Position Request',
                        'Unread',
                        fullname1,  
                        id,
                        newRequestId
                    ]
                );
            });
            await Promise.all(notificationPromises);
        }

        res.json({ 
            success: true, 
            message: 'Withdraw request submitted. Superiors have been notified.' 
        });

    } catch (error) {
        console.error('Database error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/submit-event-request', async (req, res) => {
    const { 
        fullname, ID, eventTitle, eventDescription, subdepartment, 
        eventLocation, eventDate, eventTime, eventDuration, 
        participants, resources, position
    } = req.body;

    const descriptionWordCount = countWords(eventDescription);
    if (!eventTitle || eventTitle.length < 5 || descriptionWordCount < 10 || !eventLocation) {
        return res.status(400).json({ success: false, message: 'Please check your inputs (Title min 5 chars, Description min 10 words).' });
    }

    const numericID = Number(ID);
    const Type_request = "Event Idea request";
    const Status_request = "Pending";
    const Details_request = `Organizer: ${fullname}.<br>Position: ${position}.<br>Title: ${eventTitle}.<br>Description: ${eventDescription}.<br>Sub-department : ${subdepartment}.<br>Location: ${eventLocation}.<br>Date: ${eventDate}.<br>Time: ${eventTime}.<br>Duration: ${eventDuration}.<br>Participants: ${participants}.<br>Resources: ${resources}`;

    try {
        const userCheck = await pool.query(
            'SELECT "UserID" FROM "Users" WHERE "UserID" = $1 AND "Username" ILIKE $2',
            [numericID, fullname.trim()]
        );
        
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Invalid Username or Registration Number' });
        }

        const requestResult = await pool.query(
            `INSERT INTO "Request" ("Type_request", "Details_request", "Status_request", "UserID", "Created_at")
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            RETURNING "RequestID"`,  
            [Type_request, Details_request, Status_request, numericID]
        );

        const newRequestId = requestResult.rows[0].RequestID;

        const leadersQuery = await pool.query(
            `SELECT "UserID" FROM "President" UNION SELECT "UserID" FROM "Vice_President"`
        );
        
        const receiverIDs = leadersQuery.rows.map(r => r.UserID);

        if (receiverIDs.length > 0) {
            const notificationPromises = receiverIDs.map(id => {
                return pool.query(
                    `INSERT INTO "Notification" (
                        "Details_notification", 
                        "Type_notification", 
                        "Status_notification", 
                        "Sender", 
                        "UserID",
                        "RequestID",
                        "Time"
                    ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,  
                    [
                        Details_request,  
                        'Event Proposal',
                        'Unread',
                        fullname,
                        id,
                        newRequestId
                    ]
                );
            });
            await Promise.all(notificationPromises);
        }
        
        res.json({ success: true, message: 'Event approval request submitted successfully!' });
        
    } catch (error) {
        console.error('Database error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/event-join-request', async (req, res) => {
    const { 
        fullname, 
        ID, 
        eventName,
        role,
        motivation,
        participationReason, 
    } = req.body;

    
    const participationWordCount = countWords(participationReason);
    if (!participationReason || participationWordCount < 10) {
        return res.status(400).json({ 
            success: false, 
            message: `Participation reason must be at least 10 words (currently ${participationWordCount})` 
        });
    }

    const numericID = Number(ID);
    const Type_request = "Event Join request";
    const Status_request = "Pending";
    const Details_request = `User: ${fullname}.<br>Event name: ${eventName}.<br>Role: ${role}.<br>Heard via: ${motivation}.<br>Participation reason: ${participationReason}`;

    try {
        const userCheck = await pool.query(
            'SELECT "UserID" FROM "Users" WHERE "UserID" = $1 AND "Username" ILIKE $2',
            [numericID, fullname.trim()]
        );
        
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Invalid Username or Registration Number' });
        }

        const requestResult = await pool.query(
            `INSERT INTO "Request" ("Type_request", "Details_request", "Status_request", "UserID", "Created_at")
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            RETURNING "RequestID"`,
            [Type_request, Details_request, Status_request, numericID]
        );

        const newRequestId = requestResult.rows[0].RequestID; 
        const leadersQuery = await pool.query(
            `SELECT "UserID" FROM "President" UNION SELECT "UserID" FROM "Vice_President"`
        );
        
        const receiverIDs = leadersQuery.rows.map(r => r.UserID);
        if (receiverIDs.length > 0) {
            const notificationPromises = receiverIDs.map(id => {
                return pool.query(
                    `INSERT INTO "Notification" (
                        "Details_notification", 
                        "Type_notification", 
                        "Status_notification", 
                        "Sender", 
                        "UserID",
                        "RequestID",
                        "Time"
                    ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`, 
                    [
                        Details_request,
                        'Event Join Request',
                        'Unread',
                        fullname,
                        id,
                        newRequestId
                    ]
                );
            });
            
            await Promise.all(notificationPromises);
        }

        res.json({ success: true, message: 'Join request submitted successfully!' });
        
    } catch (error) {
        console.error('Database error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/nomination-user', async (req, res) => {
    const { 
        fullname, ID, role, whyApply, skills, membership, department, subdepartment
    } = req.body;

    const numericID = Number(ID);
    const whyApplyWordCount = countWords(whyApply);

    if (isNaN(numericID) || whyApplyWordCount < 10 || !skills || skills.length < 50) {
        return res.status(400).json({ success: false, message: 'Validation failed. Check your inputs.' });
    }

    const Type_request = "Nomination request";
    const Status_request = "Pending";
    const Details_request = `Candidate: ${fullname}.<br>Target Position: ${role}.<br>Department: ${department}.<br>Sub-Department: ${subdepartment}.<br>Reason for nomination: ${whyApply}.<br>Skills: ${skills}`;

    try {

        const query = `
            SELECT m."Membership_date" 
            FROM "Users" u
            JOIN "Member" m ON u."UserID" = m."UserID"
            WHERE u."UserID" = $1 AND u."Username" ILIKE $2
        `;
        
        const userCheck = await pool.query(query, [numericID, fullname.trim()]);

        if (userCheck.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'Verification failed. Only registered members can apply.' });
        }

        const dbDateObj = userCheck.rows[0].Membership_date;
        const dbDateString = new Intl.DateTimeFormat('en-CA').format(dbDateObj);

        if (dbDateString !== membership) {
            return res.status(403).json({ success: false, message: `Date mismatch. Records show ${dbDateString}.` });
        }

       const insertResult = await pool.query(
            `INSERT INTO "Request" ("Type_request", "Details_request", "Status_request", "UserID", "Created_at")
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            RETURNING "RequestID"`,
            [Type_request, Details_request, Status_request, numericID]
        );

        const newRequestId = insertResult.rows[0].RequestID;

        
        const leadersQuery = await pool.query(
            `SELECT "UserID" FROM "President" UNION SELECT "UserID" FROM "Vice_President"`
        );
        
        const receiverIDs = leadersQuery.rows.map(r => r.UserID);

        if (receiverIDs.length > 0) {
            const notificationPromises = receiverIDs.map(id => {
                return pool.query(
                    `INSERT INTO "Notification" (
                        "Details_notification", 
                        "Type_notification", 
                        "Status_notification", 
                        "Sender", 
                        "UserID",
                        "RequestID",
                        "Time"
                    ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
                    [
                        Details_request,
                        'Nomination Request',
                        'Unread',
                        fullname,
                        id,
                        newRequestId
                    ]
                );
            });
            await Promise.all(notificationPromises);
        }

        res.json({ 
            success: true, 
            message: `Nomination submitted!`
        });

    } catch (error) {
        console.error('Database Error:', error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});


app.get('/api/user-requests/:userId', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const result = await pool.query(
            `SELECT r.* 
             FROM "Request" r
             LEFT JOIN "UserHiddenRequests" uhr 
                ON r."RequestID" = uhr."RequestID" 
                AND uhr."UserID" = $1
             WHERE r."UserID" = $1 
                AND uhr."RequestID" IS NULL
             ORDER BY r."RequestID" DESC`,
            [userId]
        );
        
        res.json({
            success: true,
            requests: result.rows
        });
    } catch (error) {
        console.error('Error fetching user requests:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/admin/notifications/:adminId', async (req, res) => {
    const { adminId } = req.params;
    try {
        
        const result = await pool.query(
            `SELECT n.* 
             FROM "Notification" n
             LEFT JOIN "UserHiddenNotifications" unh 
                ON n."NotificationID" = unh."NotificationID" 
                AND unh."UserID" = $1
             WHERE n."UserID" = $1 
                AND unh."NotificationID" IS NULL
             ORDER BY n."Time" DESC`,
            [adminId]
        );
        
        res.json({ success: true, notifications: result.rows });
    } catch (error) {
        console.error('Database error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/notifications/mark-seen/:id', async (req, res) => {
    const notifId = req.params.id;
    try {
        const result = await pool.query(
            `UPDATE "Notification" SET "Status_notification" = 'Seen' WHERE "NotificationID" = $1`,
            [notifId]
        );
        console.log(notifId);
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Notification not found" });
        }

        res.json({ success: true, message: "Status changed" });
    } catch (err) {
        console.error("Database Error:", err);
        res.status(500).json({ success: false, error: "Something went wrong" });
    }
});

app.post('/api/submit-reply', async (req, res) => {
    const { 
        originalNotificationId,
        fromUsername,
        toUsername,
        replyStatus,
        details,
        originalSender,
        originalType
    } = req.body;
    
    try {
        const wordCount = countWords(details);
        if (wordCount < 10) {
            return res.status(400).json({ 
                success: false, 
                message: `Details must be at least 10 words (currently ${wordCount} words)` 
            });
        }
        
        const cleanType = originalType ? originalType.split('?')[0] : 'Request';
        
        const notifQuery = await pool.query(
            `SELECT n."RequestID", n."Details_notification", n."Sender", u."Email", u."Username"
             FROM "Notification" n
             LEFT JOIN "Users" u ON n."Sender" = u."Username"
             WHERE n."NotificationID" = $1`,
            [originalNotificationId]
        );

        if (notifQuery.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }

        const requestId = notifQuery.rows[0].RequestID;
        let recipientEmail = notifQuery.rows[0].Email;
        const detailsNotification = notifQuery.rows[0].Details_notification || '';

        let extractedUsername = null;
        let extractedUserId = null;
        let generatedPassword = null;

        const emailMatch = detailsNotification.match(/Email: (.+?)(?:\n|$)/);
        if (emailMatch) {
            recipientEmail = emailMatch[1].trim();
        }

        const usernameMatch = detailsNotification.match(/Username: (.+?)(?:\n|$)/);
        if (usernameMatch) {
            extractedUsername = usernameMatch[1].trim();
        }

        const idMatch = detailsNotification.match(/Registration Number: (.+?)(?:\n|$)/);
        if (idMatch) {
            extractedUserId = idMatch[1].trim();
        }
        
        const isApproved = replyStatus === 'Approved';

        if (isApproved && extractedUserId && extractedUsername && recipientEmail) {
            const existingUser = await pool.query(
                'SELECT "UserID" FROM "Users" WHERE "UserID" = $1',
                [extractedUserId]
            );
            
            if (existingUser.rows.length === 0) {
                generatedPassword = generateRandomPassword(10);
                const hashedPassword = await bcrypt.hash(generatedPassword, 10);
                const formattedUsername = extractedUsername.startsWith('@') ? extractedUsername : `@${extractedUsername}`;
                
                await pool.query(
                    `INSERT INTO "Users" ("UserID", "Username", "Password", "Email", "Faculty_name", "Level", "Role", "DepartmentID")
                     VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL)`,
                    [extractedUserId, formattedUsername, hashedPassword, recipientEmail]
                );
                
                console.log(`✅ User account created for ${formattedUsername}`);

                const emailHtml = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0b1421; color: #fff; border-radius: 10px;">
                        <div style="text-align: center; margin-bottom: 20px;">
                            <h2 style="color: #00d4ff;">Catalyst Chemistry Club</h2>
                            <p style="color: #94a3b8;">University of Boumerdes</p>
                        </div>
                        <div style="background: #111d2b; padding: 20px; border-radius: 10px; border-left: 4px solid #4ecb71;">
                            <h3 style="color: #4ecb71;">✅ Join Request Approved!</h3>
                            <p style="color: #cbd5e1;"><strong>From:</strong> ${fromUsername} (Manager)</p>
                            <hr style="border-color: #2d3748; margin: 15px 0;">
                            <p style="color: #fff;"><strong>Manager's Response:</strong></p>
                            <p style="color: #94a3b8;">${details}</p>
                            <div style="background: #0f172a; padding: 12px; border-radius: 8px; margin-top: 15px;">
                                <p style="color: #4ecb71;">🎉 Your account has been created!</p>
                                <p><strong>Username:</strong> <span style="color: #00d4ff;">${formattedUsername}</span></p>
                                <p><strong>Password:</strong> <span style="color: #ffa500;">${generatedPassword}</span></p>
                                <p><strong>ID:</strong> <span style="color: #00d4ff;">${extractedUserId}</span></p>
                            </div>
                            <hr style="border-color: #2d3748; margin: 15px 0;">
                            <p style="color: #94a3b8; font-size: 12px;">Login at: http://localhost:3000</p>
                        </div>
                    </div>
                `;
                
                await emailTransporter.sendMail({
                    from: `"Catalyst Club" <${process.env.EMAIL_USER}>`,
                    to: recipientEmail,
                    subject: `Catalyst Club - Join Request Approved`,
                    html: emailHtml
                });
                console.log(`✅ Email sent to ${recipientEmail} with password`);
            }
        } else if (!isApproved) {

            const emailHtml = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0b1421; color: #fff; border-radius: 10px;">
                    <div style="background: #111d2b; padding: 20px; border-radius: 10px; border-left: 4px solid #ff4444;">
                        <h3 style="color: #ff4444;">❌ Join Request Rejected</h3>
                        <p><strong>From:</strong> ${fromUsername} (Manager)</p>
                        <hr>
                        <p><strong>Response:</strong></p>
                        <p>${details}</p>
                        <hr>
                        <p style="color: #94a3b8; font-size: 12px;">You can reapply at: http://localhost:3000</p>
                    </div>
                </div>
            `;
            
            await emailTransporter.sendMail({
                from: `"Catalyst Club" <${process.env.EMAIL_USER}>`,
                to: recipientEmail,
                subject: `Catalyst Club - Join Request Rejected`,
                html: emailHtml
            });
        }

        if (originalNotificationId) {
            await pool.query(
                `UPDATE "Notification" SET "Status_notification" = 'Replied' WHERE "NotificationID" = $1`,
                [originalNotificationId]
            );
        }
        
        res.json({ success: true, message: 'Reply sent via email!' });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

function generateRandomPassword(length = 10) {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    let password = '';

    password += letters.charAt(Math.floor(Math.random() * letters.length));
    password += numbers.charAt(Math.floor(Math.random() * numbers.length));

    const allChars = letters + numbers;
    for (let i = password.length; i < length; i++) {
        password += allChars.charAt(Math.floor(Math.random() * allChars.length));
    }

    return password.split('').sort(() => Math.random() - 0.5).join('');
}

app.delete('/api/hide-request/:notificationId', async (req, res) => {
    const { notificationId } = req.params;
    const { userId } = req.query; 
    
    if (!userId) {
        return res.status(400).json({ success: false, message: 'User ID required' });
    }
    
    try {

        const notifQuery = await pool.query(
            'SELECT "RequestID" FROM "Notification" WHERE "NotificationID" = $1',
            [notificationId]
        );
        
        if (notifQuery.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }
        
        const requestId = notifQuery.rows[0].RequestID;
        
        if (requestId) {
            await pool.query(
                `INSERT INTO "UserHiddenRequests" ("UserID", "RequestID") 
                 VALUES ($1, $2) 
                 ON CONFLICT ("UserID", "RequestID") DO NOTHING`,
                [userId, requestId]
            );
        }

        await pool.query(
            `INSERT INTO "UserHiddenNotifications" ("UserID", "NotificationID") 
             VALUES ($1, $2) 
             ON CONFLICT ("UserID", "NotificationID") DO NOTHING`,
            [userId, notificationId]
        );
        
        res.json({ success: true, message: 'Request hidden successfully' });
        
    } catch (error) {
        console.error('Error hiding request:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/reply-request', async (req, res) => {
    const { 
        originalNotificationId,
        fromUsername,
        toUsername,
        replyStatus,
        details,
        originalSender,
        originalType
    } = req.body;

    console.log('📝 Reply request received:', { originalNotificationId, fromUsername, originalSender, originalType });
    
    try {
        const wordCount = countWords(details);
        if (wordCount < 10) {
            return res.status(400).json({ 
                success: false, 
                message: `Details must be at least 10 words (currently ${wordCount} words)` 
            });
        }
        
        const cleanType = originalType ? originalType.split('?')[0] : 'Request';

        const notifQuery = await pool.query(
            'SELECT "RequestID" FROM "Notification" WHERE "NotificationID" = $1',
            [originalNotificationId]
        );
        
        console.log('📌 Notification query result:', notifQuery.rows);
        
        if (notifQuery.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }
        
        const requestId = notifQuery.rows[0].RequestID;
        const trimmedOriginalSender = originalSender ? originalSender.trim() : null;
        const senderQuery = await pool.query(
            'SELECT "UserID" FROM "Users" WHERE "Username" = $1',
            [trimmedOriginalSender]
        );
        
        console.log('👤 Sender query result:', { originalSender, found: senderQuery.rows.length > 0, recipientID: senderQuery.rows[0]?.UserID });
        
        if (senderQuery.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Recipient not found' });
        }
        
        const recipientID = senderQuery.rows[0].UserID;

        const detailsWithBreaks = details.replace(/\n/g, '<br>');
        
        const insertResult = await pool.query(
            `INSERT INTO "Notification" ("Details_notification", "Type_notification", "Status_notification", "Sender", "UserID", "RequestID", "Time")
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
             RETURNING "NotificationID"`,
            [
                `Reply to your ${cleanType} request: ${replyStatus}<br><br>${detailsWithBreaks}`,
                'Reply to Request',
                'Unread',
                fromUsername,
                recipientID,
                requestId
            ]
        );
        
        console.log('✅ Notification created with ID:', insertResult.rows[0].NotificationID);

        let newStatus = 'Pending';
        if (replyStatus === 'Approved') {
            newStatus = 'approved';
        } else if (replyStatus === 'Rejected') {
            newStatus = 'rejected';
        }
        
        await pool.query(
            `UPDATE "Request" SET "Status_request" = $1 WHERE "RequestID" = $2`,
            [newStatus, requestId]
        );

        if (originalNotificationId) {
            await pool.query(
                `UPDATE "Notification" SET "Status_notification" = 'Replied' WHERE "NotificationID" = $1`,
                [originalNotificationId]
            );
        console.log('✅ Original notification marked as Replied:', originalNotificationId);

            await pool.query(
            `UPDATE "Notification" 
            SET "Status_notification" = 'Replied' 
            WHERE "RequestID" = $1 
            AND "NotificationID" != $2
            AND "UserID" IN (SELECT "UserID" FROM "President" UNION SELECT "UserID" FROM "Vice_President")`,
            [requestId, originalNotificationId]
        );
            console.log(`✅ Marked all other notifications for RequestID ${requestId} as Replied`);
        }
        
        res.json({ success: true, message: 'Reply saved successfully' });
        
    } catch (error) {
        console.error('❌ Error submitting reply:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

app.post('/api/submit-post', upload.single('image'), async (req, res) => {
    const { 
        department,
        subdepartment,
        postType,
        title,
        description,
        eventDate,
        eventTime,
        poster
    } = req.body;

    console.log("📝 Post submission received:", {
        department,
        subdepartment,
        postType,
        title: title?.substring(0, 50),
        poster
    });

    if (!title || title.length < 5) {
        return res.status(400).json({ success: false, message: 'Title must be at least 5 characters' });
    }
    
    if (!description || countWords(description) < 20) {
        return res.status(400).json({ success: false, message: 'Description must be at least 20 words' });
    }

    const posterID = Number(poster);
    let imagePath = null;
    
    if (req.file) {
        imagePath = `/uploads/${req.file.filename}`;
    }

    try {
        const userResult = await pool.query(
            'SELECT "UserID", "Username", "Role" FROM "Users" WHERE "UserID" = $1',
            [posterID]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        const posterInfo = userResult.rows[0];
        const posterRole = (posterInfo.Role || 'none').toLowerCase();
        
        console.log(`👤 Poster: ${posterInfo.Username}, Role: ${posterRole}`);

        let fullDescription = `Department: ${department}<br>`;
        fullDescription += `Sub-department: ${subdepartment}<br>`;
        if (eventDate) fullDescription += `Event Date: ${eventDate}<br>`;
        if (eventTime) fullDescription += `Event Time: ${eventTime}<br>`;
        fullDescription += `<br>${description}`;

        const postResult = await pool.query(
            `INSERT INTO "Post" ("Type_post", "Title_post", "Description_post", "Poster", "Date_post", "Image")
             VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)
             RETURNING "PostID"`,
            [postType, title, fullDescription, posterID, imagePath]
        );
        
        const newPostId = postResult.rows[0].PostID;
        console.log(`✅ Post created with ID: ${newPostId}`);

        let recipients = [];
        let contextInfo = '';

        if (posterRole === 'manager') {
            console.log(`🔔 Manager post - finding recipients for department: ${department}`);
            recipients = await getRecipientsForManagerPost(posterID, department);
            contextInfo = `${department} Department`;
            
        } else if (posterRole === 'instructor') {
            console.log(`🔔 Instructor post - finding recipients for sub-department: ${subdepartment}`);
            recipients = await getRecipientsForInstructorPost(posterID, subdepartment);
            contextInfo = `${subdepartment}`;
            
        } else if (posterRole === 'president' || posterRole === 'vice president') {
            console.log(`🔔 ${posterRole} post - sending to ALL club members`);
            
            const allMembers = await pool.query(
                `SELECT "UserID" FROM "Users" 
                 WHERE "Role" IS NOT NULL 
                 AND "Role" != 'none'
                 AND "UserID" != $1`,
                [posterID]
            );
            recipients = allMembers.rows.map(row => row.UserID);
            contextInfo = `Club Announcement`;
            
            console.log(`📨 Found ${recipients.length} members to notify`);
        } else {
            console.log(`⚠️ Unknown role: ${posterRole}, no notifications sent`);
        }

        const presidentIds = await getPresidentIds();
        const filteredPresidentIds = presidentIds.filter(id => id != posterID);

        const vpResult = await pool.query(`SELECT "UserID" FROM "Vice_President" WHERE "ClubID" = 1`);
        const vpIds = vpResult.rows.map(row => row.UserID);
        const filteredVpIds = vpIds.filter(id => id != posterID);

        for (const presidentId of filteredPresidentIds) {
            if (!recipients.includes(presidentId)) {
                recipients.push(presidentId);
            }
        }

        for (const vpId of filteredVpIds) {
            if (!recipients.includes(vpId)) {
                recipients.push(vpId);
            }
        }

        console.log(`📨 Total recipients after adding leadership: ${recipients.length}`);

        if (recipients.length > 0) {
            console.log(`📨 Creating ${recipients.length} notifications...`);
            await createPostNotifications(
                newPostId, 
                posterID, 
                posterInfo.Username, 
                title, 
                recipients, 
                contextInfo
            );
        } else {
            console.log(`⚠️ No recipients found for this post`);
        }

        res.json({ success: true, message: 'Post published successfully!' });
        
    } catch (error) {
        console.error('❌ Error publishing post:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

app.get('/api/get-posts/:type', async (req, res) => {
    const { type } = req.params;
    const userRole = req.query.role || 'none';
    
    try {
        let result;

        if (userRole === 'none') {
            result = await pool.query(
                `SELECT p.*, u."Username" as poster_name
                 FROM "Post" p
                 JOIN "Users" u ON p."Poster" = u."UserID"
                 WHERE p."Type_post" = $1
                 ORDER BY p."Date_post" DESC, p."PostID" DESC
                 LIMIT 5`,
                [type]
            );
        } else {

            result = await pool.query(
                `SELECT p.*, u."Username" as poster_name
                 FROM "Post" p
                 JOIN "Users" u ON p."Poster" = u."UserID"
                 WHERE p."Type_post" = $1
                 ORDER BY p."Date_post" DESC, p."PostID" DESC`,
                [type]
            );
        }
        
        res.json({ success: true, posts: result.rows });
    } catch (error) {
        console.error('Error fetching posts:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/get-all-posts', async (req, res) => {

    const userRole = req.query.role || 'none';
    
    try {
        let result;

        if (userRole === 'none') {
            
            const events = await pool.query(
                `SELECT p.*, u."Username" as poster_name
                 FROM "Post" p
                 JOIN "Users" u ON p."Poster" = u."UserID"
                 WHERE p."Type_post" = 'Event'
                 ORDER BY p."Date_post" DESC, p."PostID" DESC
                 LIMIT 5`
            );

            const workshops = await pool.query(
                `SELECT p.*, u."Username" as poster_name
                 FROM "Post" p
                 JOIN "Users" u ON p."Poster" = u."UserID"
                 WHERE p."Type_post" = 'Workshop'
                 ORDER BY p."Date_post" DESC, p."PostID" DESC
                 LIMIT 5`
            );

            const announcements = await pool.query(
                `SELECT p.*, u."Username" as poster_name
                 FROM "Post" p
                 JOIN "Users" u ON p."Poster" = u."UserID"
                 WHERE p."Type_post" = 'Informative'
                 ORDER BY p."Date_post" DESC, p."PostID" DESC
                 LIMIT 5`
            );

            const allPosts = [...events.rows, ...workshops.rows, ...announcements.rows];

            allPosts.sort((a, b) => {
                const dateA = new Date(a.Date_post);
                const dateB = new Date(b.Date_post);
                return dateB - dateA;
            });
            
            result = allPosts;
        } else {
            result = await pool.query(
                `SELECT p.*, u."Username" as poster_name
                 FROM "Post" p
                 JOIN "Users" u ON p."Poster" = u."UserID"
                 ORDER BY p."Date_post" DESC, p."PostID" DESC`
            );
            result = result.rows;
        }
        
        res.json({ success: true, posts: result });
        
    } catch (error) {
        console.error('Error fetching posts:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/user-posts/:userId', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const result = await pool.query(
            `SELECT p.*, u."Username" as poster_name
             FROM "Post" p
             JOIN "Users" u ON p."Poster" = u."UserID"
             WHERE p."Poster" = $1
             ORDER BY p."Date_post" DESC, p."PostID" DESC`,
            [userId]
        );
        
        res.json({ success: true, posts: result.rows });
    } catch (error) {
        console.error('Error fetching user posts:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.delete('/api/delete-post/:postId', async (req, res) => {
    const { postId } = req.params;
    
    try {
        const postCheck = await pool.query(
            'SELECT "PostID" FROM "Post" WHERE "PostID" = $1',
            [postId]
        );
        
        if (postCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Post not found' });
        }
        
        await pool.query('DELETE FROM "Post" WHERE "PostID" = $1', [postId]);
        
        res.json({ success: true, message: 'Post deleted successfully' });
    } catch (error) {
        console.error('Error deleting post:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/department/members/:managerId', async (req, res) => {
    const { managerId } = req.params;
    
    try {
        const departmentId = await getManagerDepartment(managerId);
        if (!departmentId) {
            return res.status(403).json({ success: false, message: 'You are not a manager' });
        }

         const members = await pool.query(
            `SELECT 
                u."UserID", 
                u."Username", 
                u."Level", 
                u."Faculty_name" as "Faculty",
                u."Role",
                sd."Sub_department_name" as "Sub_department"
             FROM "Member" m
             JOIN "Users" u ON m."UserID" = u."UserID"
             JOIN "Sub_department" sd ON m."Sub_departmentID" = sd."Sub_departmentID"
             WHERE sd."DepartmentID" = $1
             ORDER BY sd."Sub_department_name", u."Username"`,
            [departmentId]
        );

        const allMembers = members.rows.map(member => ({
            UserID: member.UserID,
            Username: member.Username,
            Level: member.Level,
            Faculty: member.Faculty,
            Sub_department: member.Sub_department,
            Role: member.Role === 'instructor' ? 'instructor' : 'member'
        }));
         res.json({ 
            success: true, 
            members: allMembers,
            departmentId: departmentId
        });

    } catch (error) {
        console.error('Error fetching department members:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/department/search-user/:searchTerm', async (req, res) => {
    const { searchTerm } = req.params;
    
    try {
        let result;
        if (/^\d+$/.test(searchTerm)) {
            result = await pool.query(
                `SELECT "UserID", "Username", "Level", "Faculty_name" as "Faculty"
                 FROM "Users"
                 WHERE "UserID" = $1`,
                [searchTerm]
            );
        } else {
            let username = searchTerm;
            if (!username.startsWith('@')) {
                username = '@' + username;
            }
            result = await pool.query(
                `SELECT "UserID", "Username", "Level", "Faculty_name" as "Faculty"
                 FROM "Users"
                 WHERE "Username" ILIKE $1`,
                [username]
            );
        }

        if (result.rows.length === 0) {
            return res.json({ success: false, message: 'User not found' });
        }
        
        res.json({ success: true, user: result.rows[0] });
        
    } catch (error) {
        console.error('Error searching user:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/department/add-member', async (req, res) => {
    const { managerId, userId, role, subDepartmentName } = req.body;
    
    try {
        const departmentId = await getManagerDepartment(managerId);
        if (!departmentId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        const subDeptResult = await pool.query(
            `SELECT sd."Sub_departmentID", sd."Sub_department_name", sd."DepartmentID"
             FROM "Sub_department" sd
             WHERE sd."DepartmentID" = $1 AND sd."Sub_department_name" = $2`,
            [departmentId, subDepartmentName]
        );
        
        if (subDeptResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid sub-department' });
        }
        
        const subDepartmentId = subDeptResult.rows[0].Sub_departmentID;
        const newDepartmentId = subDeptResult.rows[0].DepartmentID;
        const userCheck = await pool.query(
            `SELECT "UserID", "Username", "Faculty_name", "Level" FROM "Users" WHERE "UserID" = $1`,
            [userId]
        );
        
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'User not found. User must first submit a join request and get approved.' 
            });
        }
        const existingMember = await pool.query(
            `SELECT "UserID" FROM "Member" WHERE "UserID" = $1`,
            [userId]
        );
        
        if (existingMember.rows.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'User is already a member of this department' 
            });
        }
        
        if (role === 'instructor') {
            const existingInstructor = await pool.query(
                `SELECT i."UserID", u."Username"
                 FROM "Instructor" i
                 JOIN "Users" u ON i."UserID" = u."UserID"
                 WHERE i."Sub_departmentID" = $1`,
                [subDepartmentId]
            );
            
            if (existingInstructor.rows.length > 0) {
                return res.status(400).json({ 
                    success: false, 
                    message: `This sub-department already has an instructor (${existingInstructor.rows[0].Username})` 
                });
            }
        }

        const managerInfo = await pool.query(
            'SELECT "Username" FROM "Users" WHERE "UserID" = $1',
            [managerId]
        );
        const managerName = managerInfo.rows[0]?.Username || 'A manager';

        const userRole = role === 'instructor' ? 'instructor' : 'member';

        const { facultyName, level } = req.body;
        
        await pool.query(
            `UPDATE "Users" 
             SET "Faculty_name" = COALESCE($1, "Faculty_name"),
                 "Level" = COALESCE($2, "Level"),
                 "Role" = $3,
                 "DepartmentID" = $4
             WHERE "UserID" = $5`,
            [facultyName, level, userRole, newDepartmentId, userId]
        );
        
        await pool.query(
            `INSERT INTO "Member" ("UserID", "Membership_date", "Sub_departmentID")
             VALUES ($1, CURRENT_DATE, $2)`,
            [userId, subDepartmentId]
        );
        
        if (role === 'instructor') {
            await pool.query(
                `INSERT INTO "Instructor" ("UserID", "Sub_departmentID")
                 VALUES ($1, $2)`,
                [userId, subDepartmentId]
            );
        }
        
        const notificationMessage = role === 'instructor' 
            ? `${managerName} has added you as an INSTRUCTOR for ${subDepartmentName} sub-department.`
            : `${managerName} has added you as a MEMBER of ${subDepartmentName} sub-department.`;
        
        await pool.query(
            `INSERT INTO "Notification" (
                "Details_notification", 
                "Type_notification", 
                "Status_notification", 
                "Sender", 
                "UserID",
                "Time"
            ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
            [notificationMessage, 'Role Assignment', 'Unread', managerName, userId]
        );
        
        res.json({ success: true, message: `${role} added successfully!` });
        
    } catch (error) {
        console.error('Error adding member:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});
app.get('/api/department/search-user/:searchTerm', async (req, res) => {
    const { searchTerm } = req.params;
    
    try {
        let result;
        
        if (/^\d+$/.test(searchTerm)) {
            result = await pool.query(
                `SELECT "UserID", "Username", "Email"
                 FROM "Users"
                 WHERE "UserID" = $1 
                 AND "Role" IS NULL  /* User hasn't been assigned a role yet */
                 AND "UserID" NOT IN (SELECT "UserID" FROM "Member") /* Not a member yet */`,
                [searchTerm]
            );
        } else {
            let username = searchTerm;
            if (!username.startsWith('@')) {
                username = '@' + username;
            }
            result = await pool.query(
                `SELECT "UserID", "Username", "Email"
                 FROM "Users"
                 WHERE "Username" = $1 
                 AND "Role" IS NULL
                 AND "UserID" NOT IN (SELECT "UserID" FROM "Member")`,
                [username]
            );
        }
        
        if (result.rows.length === 0) {
            return res.json({ 
                success: false, 
                message: 'User not found or already a member. User must first submit and get approval for a join request.' 
            });
        }
        
        res.json({ success: true, user: result.rows[0] });
        
    } catch (error) {
        console.error('Error searching user:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.delete('/api/department/remove-member', async (req, res) => {
    const { managerId, userId, role } = req.body;
    
    try {
        const departmentId = await getManagerDepartment(managerId);
        if (!departmentId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        const userInfo = await pool.query(
            'SELECT "Username", "Role" FROM "Users" WHERE "UserID" = $1',
            [userId]
        );
        
        if (userInfo.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        const deptInfo = await pool.query(
            `SELECT d."Department_name" 
             FROM "Department" d
             WHERE d."DepartmentID" = $1`,
            [departmentId]
        );
        
        const departmentName = deptInfo.rows[0]?.Department_name || 'your department';
        
        const notificationDetails = `You have been removed from the ${departmentName} department by a manager. Your ${role} role has been revoked.`;
        
        await pool.query(
            `INSERT INTO "Notification" (
                "Details_notification", 
                "Type_notification", 
                "Status_notification", 
                "Sender", 
                "UserID",
                "Time"
            ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
            [
                notificationDetails,
                'Department Removal',
                'Unread',
                'System',
                userId
            ]
        );
        
        await pool.query(`DELETE FROM "Member" WHERE "UserID" = $1`, [userId]);        
        await pool.query(`DELETE FROM "Instructor" WHERE "UserID" = $1`, [userId]);
        await pool.query(
            `UPDATE "Users" SET "Role" = 'none', "DepartmentID" = 0 WHERE "UserID" = $1`,
            [userId]
        );
        
        res.json({ success: true, message: `${role} removed successfully. Notification sent.` });
        
    } catch (error) {
        console.error('Error removing member:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/user/departments/:userId', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const departments = await pool.query(
            `SELECT 
                d."DepartmentID",
                d."Department_name",
                sd."Sub_departmentID",
                sd."Sub_department_name",
                u."Role" as user_role,
                CASE 
                    WHEN m."UserID" IS NOT NULL THEN 'Member'
                    ELSE NULL
                END as membership_type
             FROM "Users" u
             LEFT JOIN "Member" m ON u."UserID" = m."UserID"
             LEFT JOIN "Sub_department" sd ON m."Sub_departmentID" = sd."Sub_departmentID"
             LEFT JOIN "Department" d ON sd."DepartmentID" = d."DepartmentID"
             WHERE u."UserID" = $1
             ORDER BY d."Department_name"`,
            [userId]
        );
        
        const managerDept = await pool.query(
            `SELECT d."DepartmentID", d."Department_name"
             FROM "Manager" mg
             JOIN "Department" d ON mg."DepartmentID" = d."DepartmentID"
             WHERE mg."UserID" = $1`,
            [userId]
        );
        
        const allDepartments = [];
        
        departments.rows.forEach(row => {
            if (row.DepartmentID) {
                allDepartments.push({
                    DepartmentID: row.DepartmentID,
                    Department_name: row.Department_name,
                    Sub_departmentID: row.Sub_departmentID,
                    Sub_department_name: row.Sub_department_name,
                    Role: row.user_role
                });
            }
        });
        
        managerDept.rows.forEach(row => {
            const exists = allDepartments.some(d => d.DepartmentID === row.DepartmentID);
            if (!exists) {
                allDepartments.push({
                    DepartmentID: row.DepartmentID,
                    Department_name: row.Department_name,
                    Role: 'manager'
                });
            }
        });
        
        res.json({ 
            success: true, 
            departments: allDepartments
        });
        
    } catch (error) {
        console.error('Error fetching user departments:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/user/:userId', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const result = await pool.query(
            `SELECT "UserID", "Username", "Email", "Faculty_name", "Level", "Role", "DepartmentID"
             FROM "Users"
             WHERE "UserID" = $1`,
            [userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        const user = result.rows[0];
        
        res.json({
            success: true,
            user: {
                id: user.UserID,
                username: user.Username,
                email: user.Email,
                faculty: user.Faculty_name,
                level: user.Level,
                role: user.Role,
                DepartmentID: user.DepartmentID || 0
            }
        });
        
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.put('/api/department/modify-member', async (req, res) => {
    const { managerId, userId, currentRole, newRole, newSubDepartmentName } = req.body;
    
    try {
        const departmentId = await getManagerDepartment(managerId);
        if (!departmentId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        const subDeptResult = await pool.query(
            `SELECT "Sub_departmentID", "Sub_department_name" FROM "Sub_department" 
             WHERE "DepartmentID" = $1 AND "Sub_department_name" = $2`,
            [departmentId, newSubDepartmentName]
        );
        
        if (subDeptResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid sub-department' });
        }
        
        const newSubDepartmentId = subDeptResult.rows[0].Sub_departmentID;
        const newSubDepartmentNameCorrect = subDeptResult.rows[0].Sub_department_name;
        
        if (newRole === 'instructor') {
            const existingInstructor = await pool.query(
                `SELECT i."UserID", u."Username", u."Role"
                 FROM "Instructor" i
                 JOIN "Users" u ON i."UserID" = u."UserID"
                 WHERE i."Sub_departmentID" = $1 AND i."UserID" != $2`,
                [newSubDepartmentId, userId]
            );
            
            if (existingInstructor.rows.length > 0) {
                return res.status(400).json({ 
                    success: false, 
                    message: `This sub-department already has an instructor (${existingInstructor.rows[0].Username}). Only one instructor per sub-department is allowed.` 
                });
            }
        }
        
        const managerInfo = await pool.query(
            'SELECT "Username" FROM "Users" WHERE "UserID" = $1',
            [managerId]
        );
        const managerName = managerInfo.rows[0]?.Username || 'A manager';
        
        await pool.query('BEGIN');
        
        await pool.query(
            `UPDATE "Member" SET "Sub_departmentID" = $1 WHERE "UserID" = $2`,
            [newSubDepartmentId, userId]
        );
        
        const deptIdFromSubDept = await pool.query(
            `SELECT "DepartmentID" FROM "Sub_department" WHERE "Sub_departmentID" = $1`,
            [newSubDepartmentId]
        );
        const newDepartmentId = deptIdFromSubDept.rows[0]?.DepartmentID || 0;
        
        let roleChangeMessage = '';
        if (currentRole !== newRole) {
            const newUserRole = newRole === 'instructor' ? 'instructor' : 'member';
            await pool.query(
                `UPDATE "Users" SET "Role" = $1, "DepartmentID" = $2 WHERE "UserID" = $3`,
                [newUserRole, newDepartmentId, userId]  
            );
            
            if (newRole === 'instructor') {
                const existingInstructorRecord = await pool.query(
                    `SELECT "UserID" FROM "Instructor" WHERE "UserID" = $1`,
                    [userId]
                );
                if (existingInstructorRecord.rows.length === 0) {
                    await pool.query(
                        `INSERT INTO "Instructor" ("UserID", "Sub_departmentID")
                         VALUES ($1, $2)`,
                        [userId, newSubDepartmentId]
                    );
                } else {
                    await pool.query(
                        `UPDATE "Instructor" SET "Sub_departmentID" = $1 WHERE "UserID" = $2`,
                        [newSubDepartmentId, userId]
                    );
                }
                roleChangeMessage = `You have been PROMOTED to INSTRUCTOR of ${newSubDepartmentNameCorrect} sub-department!`;
                } else if (currentRole === 'instructor' && newRole !== 'instructor') {
                    await pool.query(`DELETE FROM "Instructor" WHERE "UserID" = $1`, [userId]);
                    roleChangeMessage = `You have been changed from Instructor to Member in ${newSubDepartmentNameCorrect} sub-department.`;
                } else {
                    roleChangeMessage = `Your role has been updated.`;
                }
        } else {
                
            await pool.query(
                `UPDATE "Users" SET "DepartmentID" = $1 WHERE "UserID" = $2`,
                [newDepartmentId, userId]
            );
            roleChangeMessage = `Your sub-department has been changed to ${newSubDepartmentNameCorrect}.`;
        }
        
        await pool.query('COMMIT');
        
        const modificationNotification = `${managerName} has modified your role. ${roleChangeMessage}`;
        await pool.query(
            `INSERT INTO "Notification" (
                "Details_notification", 
                "Type_notification", 
                "Status_notification", 
                "Sender", 
                "UserID",
                "Time"
            ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
            [
                modificationNotification,
                'Role Modification',
                'Unread',
                managerName,
                userId
            ]
        );
        
        res.json({ success: true, message: `${currentRole} modified successfully. Notification sent.` });
        
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Error modifying member:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

app.get('/api/department/subdepartments/:managerId', async (req, res) => {
    const { managerId } = req.params;
    
    try {
        const departmentId = await getManagerDepartment(managerId);
        if (!departmentId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        const subDepartments = await getSubDepartmentsByDepartment(departmentId);
        res.json({ success: true, subDepartments });
        
    } catch (error) {
        console.error('Error fetching sub-departments:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

async function isClubLeadership(userId) {
    const presidentCheck = await pool.query(
        `SELECT "UserID" FROM "President" WHERE "UserID" = $1`,
        [userId]
    );
    
    const vpCheck = await pool.query(
        `SELECT "UserID" FROM "Vice_President" WHERE "UserID" = $1`,
        [userId]
    );
    
    return presidentCheck.rows.length > 0 || vpCheck.rows.length > 0;
}

app.get('/api/club/members/:userId', async (req, res) => {
    const { userId } = req.params;
    
    try {

        const isLeader = await isClubLeadership(userId);
        if (!isLeader) {
            return res.status(403).json({ success: false, message: 'Only club leadership can access this' });
        }
        
        const members = await pool.query(
            `SELECT 
                u."UserID",
                u."Username",
                u."Level",
                u."Faculty_name" as "Faculty",
                u."Role" as "UserRole",
                CASE 
                    WHEN mg."UserID" IS NOT NULL THEN COALESCE(d_mg."Department_name", 'No Department')
                    ELSE COALESCE(d."Department_name", 'No Department')
                END as "Department",
                CASE 
                    WHEN mg."UserID" IS NOT NULL THEN 'No Sub-department'
                    ELSE COALESCE(sd."Sub_department_name", 'No Sub-department')
                END as "Sub_department",
                CASE 
                    WHEN p."UserID" IS NOT NULL THEN 'President'
                    WHEN vp."UserID" IS NOT NULL THEN 'Vice President'
                    WHEN mg."UserID" IS NOT NULL THEN 'Manager'
                    WHEN m."UserID" IS NOT NULL AND LOWER(u."Role") = 'instructor' THEN 'Instructor'
                    WHEN m."UserID" IS NOT NULL THEN 'Member'
                    ELSE 'User'
                END as "ClubRole"
             FROM "Users" u
             LEFT JOIN "Member" m ON u."UserID" = m."UserID"
             LEFT JOIN "Sub_department" sd ON m."Sub_departmentID" = sd."Sub_departmentID"
             LEFT JOIN "Department" d ON sd."DepartmentID" = d."DepartmentID"
             LEFT JOIN "President" p ON u."UserID" = p."UserID"
             LEFT JOIN "Vice_President" vp ON u."UserID" = vp."UserID"
             LEFT JOIN "Manager" mg ON u."UserID" = mg."UserID"
             LEFT JOIN "Department" d_mg ON mg."DepartmentID" = d_mg."DepartmentID"
             GROUP BY 
                u."UserID", u."Username", u."Level", u."Faculty_name", u."Role",
                d."Department_name", sd."Sub_department_name",
                d_mg."Department_name",
                p."UserID", vp."UserID", mg."UserID", m."UserID"
             ORDER BY 
                CASE 
                    WHEN p."UserID" IS NOT NULL THEN 1
                    WHEN vp."UserID" IS NOT NULL THEN 2
                    WHEN mg."UserID" IS NOT NULL THEN 3
                    WHEN m."UserID" IS NOT NULL AND LOWER(u."Role") = 'instructor' THEN 4
                    WHEN m."UserID" IS NOT NULL THEN 5
                    ELSE 6
                END,
                u."Username"`,
            []
        );
        
        const deptCount = await pool.query(
            `SELECT COUNT(*) FROM "Department"`
        );
        
        const managerCount = await pool.query(
            `SELECT COUNT(*) FROM "Manager"`
        );
        
        res.json({ 
            success: true, 
            members: members.rows,
            totalStudents: members.rows.length,
            totalDepartments: parseInt((deptCount.rows[0].count)-1),
            totalManagers: parseInt(managerCount.rows[0].count)
        });
        
    } catch (error) {
        console.error('Error fetching club members:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

app.get('/api/club/search/:userId/:searchTerm', async (req, res) => {
    const { userId, searchTerm } = req.params;
    
    try {
        const isLeader = await isClubLeadership(userId);
        if (!isLeader) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        const members = await pool.query(
            `SELECT 
                u."UserID",
                u."Username",
                u."Level",
                u."Faculty_name" as "Faculty",
                u."Role" as "UserRole",
                CASE 
                    WHEN mg."UserID" IS NOT NULL THEN COALESCE(d_mg."Department_name", 'No Department')
                    ELSE COALESCE(d."Department_name", 'No Department')
                END as "Department",
                CASE 
                    WHEN mg."UserID" IS NOT NULL THEN 'N/A'
                    ELSE COALESCE(sd."Sub_department_name", 'No Sub-department')
                END as "Sub_department",
                CASE 
                    WHEN p."UserID" IS NOT NULL THEN 'President'
                    WHEN vp."UserID" IS NOT NULL THEN 'Vice President'
                    WHEN mg."UserID" IS NOT NULL THEN 'Manager'
                    WHEN m."UserID" IS NOT NULL AND LOWER(u."Role") = 'instructor' THEN 'Instructor'
                    WHEN m."UserID" IS NOT NULL THEN 'Member'
                    ELSE 'User'
                END as "ClubRole"
             FROM "Users" u
             LEFT JOIN "Member" m ON u."UserID" = m."UserID"
             LEFT JOIN "Sub_department" sd ON m."Sub_departmentID" = sd."Sub_departmentID"
             LEFT JOIN "Department" d ON sd."DepartmentID" = d."DepartmentID"
             LEFT JOIN "President" p ON u."UserID" = p."UserID"
             LEFT JOIN "Vice_President" vp ON u."UserID" = vp."UserID"
             LEFT JOIN "Manager" mg ON u."UserID" = mg."UserID"
             LEFT JOIN "Department" d_mg ON mg."DepartmentID" = d_mg."DepartmentID"
             WHERE u."UserID"::text LIKE $1 OR u."Username" ILIKE $2
             GROUP BY 
                u."UserID", u."Username", u."Level", u."Faculty_name", u."Role",
                d."Department_name", sd."Sub_department_name",
                d_mg."Department_name",
                p."UserID", vp."UserID", mg."UserID", m."UserID"
             ORDER BY u."Username"`,
            [`%${searchTerm}%`, `%${searchTerm}%`]
        );
        
        res.json({ success: true, members: members.rows });
        
    } catch (error) {
        console.error('Error searching club members:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

app.get('/api/club/departments/:userId', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const isLeader = await isClubLeadership(userId);
        if (!isLeader) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        const departments = await pool.query(
            `SELECT "DepartmentID", "Department_name" FROM "Department" ORDER BY "Department_name"`
        );
        
        res.json({ success: true, departments: departments.rows });
        
    } catch (error) {
        console.error('Error fetching departments:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/club/search-user/:userId/:searchId', async (req, res) => {
    const { userId, searchId } = req.params;
    
    try {
        const isLeader = await isClubLeadership(userId);
        if (!isLeader) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        const result = await pool.query(
            `SELECT "UserID", "Username", "Level", "Faculty_name" as "Faculty", "Role"
             FROM "Users"
             WHERE "UserID"::text LIKE $1 OR "Username" ILIKE $2
             LIMIT 5`,
            [`%${searchId}%`, `%${searchId}%`]
        );
        
        res.json({ success: true, users: result.rows });
        
    } catch (error) {
        console.error('Error searching user:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/club/add-manager', async (req, res) => {
    const { presidentId, userId, departmentId, departmentName } = req.body;
    
    try {
        const isLeader = await isClubLeadership(presidentId);
        if (!isLeader) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        let finalDeptId = departmentId;
        if (departmentName && !finalDeptId) {
            const deptResult = await pool.query(
                `SELECT "DepartmentID" FROM "Department" WHERE "Department_name" = $1`,
                [departmentName]
            );
            if (deptResult.rows.length === 0) {
                return res.status(400).json({ success: false, message: 'Invalid department' });
            }
            finalDeptId = deptResult.rows[0].DepartmentID;
        }
        
        const existingManagerForDept = await pool.query(
            `SELECT u."UserID", u."Username" 
             FROM "Manager" m
             JOIN "Users" u ON m."UserID" = u."UserID"
             WHERE m."DepartmentID" = $1`,
            [finalDeptId]
        );
        
        if (existingManagerForDept.rows.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: `This department already has a manager (${existingManagerForDept.rows[0].Username}). Each department can only have one manager.` 
            });
        }
        
        const existingManager = await pool.query(
            `SELECT "UserID" FROM "Manager" WHERE "UserID" = $1`,
            [userId]
        );
        
        if (existingManager.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'User is already a manager' });
        }
        
        const memberRecord = await pool.query(
            `SELECT "UserID", "Sub_departmentID" FROM "Member" WHERE "UserID" = $1`,
            [userId]
        );
        
        if (memberRecord.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'User must be a club member first' });
        }
        
        const isInstructor = await pool.query(
            `SELECT "UserID" FROM "Instructor" WHERE "UserID" = $1`,
            [userId]
        );
        
        await pool.query('BEGIN');
        
        if (isInstructor.rows.length > 0) {
            await pool.query(`DELETE FROM "Instructor" WHERE "UserID" = $1`, [userId]);
            console.log(`✅ User ${userId} removed from Instructor table`);
        }
        
        await pool.query(
            `INSERT INTO "Manager" ("UserID", "DepartmentID")
             VALUES ($1, $2)`,
            [userId, finalDeptId]
        );
        
        await pool.query(
            `UPDATE "Users" SET "Role" = 'manager', "DepartmentID" = $1 WHERE "UserID" = $2`,
            [finalDeptId, userId]
        );
        
        await pool.query(
            `UPDATE "Member" SET "Sub_departmentID" = NULL WHERE "UserID" = $1`,
            [userId]
        );
        
        await pool.query('COMMIT');
        
        const deptInfo = await pool.query(
            `SELECT "Department_name" FROM "Department" WHERE "DepartmentID" = $1`,
            [finalDeptId]
        );
        const deptName = deptInfo.rows[0]?.Department_name || 'a department';
        
        const presidentInfo = await pool.query(
            'SELECT "Username" FROM "Users" WHERE "UserID" = $1',
            [presidentId]
        );
        const presidentName = presidentInfo.rows[0]?.Username || 'The President';
        
        const managerNotification = `${presidentName} has appointed you as MANAGER of ${deptName} department. You now oversee the entire department (no sub-department assigned).`;
        
        await pool.query(
            `INSERT INTO "Notification" (
                "Details_notification", 
                "Type_notification", 
                "Status_notification", 
                "Sender", 
                "UserID",
                "Time"
            ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
            [
                managerNotification,
                'Role Assignment',
                'Unread',
                presidentName,
                userId
            ]
        );
        
        res.json({ success: true, message: 'Manager added successfully.' });
        
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Error adding manager:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

app.delete('/api/club/remove-manager', async (req, res) => {
    const { presidentId, userId } = req.body;
    
    try {
        const isLeader = await isClubLeadership(presidentId);
        if (!isLeader) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        const managerCheck = await pool.query(
            `SELECT "UserID" FROM "Manager" WHERE "UserID" = $1`,
            [userId]
        );
        
        if (managerCheck.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'User is not a manager' });
        }
        
        await pool.query('BEGIN');
        
        await pool.query(`DELETE FROM "Manager" WHERE "UserID" = $1`, [userId]);
        
        const isInstructor = await pool.query(
            `SELECT "UserID" FROM "Instructor" WHERE "UserID" = $1`,
            [userId]
        );
        
        let newRole = 'none';
        
        if (isInstructor.rows.length === 0) {
            await pool.query(`DELETE FROM "Member" WHERE "UserID" = $1`, [userId]);
        }
        await pool.query(
            `UPDATE "Users" SET "Role" = $1, "DepartmentID" = 0 WHERE "UserID" = $2`,
            [newRole, userId]
        );
        
        await pool.query('COMMIT');
                
        res.json({ success: true, message: 'Manager removed successfully. Account deactivated.' });
        
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Error removing manager:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.delete('/api/club/remove-vice-president', async (req, res) => {
    const { presidentId } = req.body;
    
    try {
        const isLeader = await isClubLeadership(presidentId);
        if (!isLeader) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        const currentVP = await pool.query(
            'SELECT "UserID" FROM "Vice_President" WHERE "ClubID" = 1'
        );
        
        if (currentVP.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'No vice president found' });
        }
        
        const vpId = currentVP.rows[0].UserID;
        
        await pool.query('BEGIN');
        
        await pool.query('DELETE FROM "Vice_President" WHERE "UserID" = $1', [vpId]);
        
        const isInstructor = await pool.query(
            'SELECT "UserID" FROM "Instructor" WHERE "UserID" = $1',
            [vpId]
        );
        
        let newRole = 'none';
        
        if (isInstructor.rows.length === 0) {
            await pool.query('DELETE FROM "Member" WHERE "UserID" = $1', [vpId]);
        }
    
        await pool.query(
            'UPDATE "Users" SET "Role" = $1, "DepartmentID" = 0 WHERE "UserID" = $2',
            [newRole, vpId]
        );
        
        await pool.query('COMMIT');
        
        res.json({ success: true, message: 'Vice President removed successfully. Account deactivated.' });
        
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Error removing vice president:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.put('/api/club/modify-manager', async (req, res) => {
    const { presidentId, userId, newDepartmentId, newDepartmentName } = req.body;
    
    try {
        const isLeader = await isClubLeadership(presidentId);
        if (!isLeader) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        let finalDeptId = newDepartmentId;
        if (newDepartmentName && !finalDeptId) {
            const deptResult = await pool.query(
                `SELECT "DepartmentID" FROM "Department" WHERE "Department_name" = $1`,
                [newDepartmentName]
            );
            if (deptResult.rows.length === 0) {
                return res.status(400).json({ success: false, message: 'Invalid department' });
            }
            finalDeptId = deptResult.rows[0].DepartmentID;
        }
        
        const existingManagerForDept = await pool.query(
            `SELECT u."UserID", u."Username" 
            FROM "Manager" m
            JOIN "Users" u ON m."UserID" = u."UserID"
            WHERE m."DepartmentID" = $1 AND m."UserID" != $2`,
            [finalDeptId, userId]
        );

        if (existingManagerForDept.rows.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: `The department "${newDepartmentName || 'this department'}" already has a manager (${existingManagerForDept.rows[0].Username}). Each department can only have one manager.` 
            });
        }
        const oldDeptInfo = await pool.query(
            `SELECT d."Department_name" 
            FROM "Manager" m
            JOIN "Department" d ON m."DepartmentID" = d."DepartmentID"
            WHERE m."UserID" = $1`,
            [userId]
        );
        const oldDeptName = oldDeptInfo.rows[0]?.Department_name || 'a department';
        
        await pool.query('BEGIN');
        await pool.query(
            `UPDATE "Manager" SET "DepartmentID" = $1 WHERE "UserID" = $2`,
            [finalDeptId, userId]
        );
    
        await pool.query(
            `UPDATE "Users" SET "DepartmentID" = $1 WHERE "UserID" = $2`,
            [finalDeptId, userId]
        );
        
        await pool.query(
            `UPDATE "Member" SET "Sub_departmentID" = NULL WHERE "UserID" = $1`,
            [userId]
        );
        
        await pool.query('COMMIT');
        
        const newDeptInfo = await pool.query(
            `SELECT "Department_name" FROM "Department" WHERE "DepartmentID" = $1`,
            [finalDeptId]
        );
        const newDeptName = newDeptInfo.rows[0]?.Department_name || 'another department';
        
        const presidentInfo = await pool.query(
            'SELECT "Username" FROM "Users" WHERE "UserID" = $1',
            [presidentId]
        );
        const presidentName = presidentInfo.rows[0]?.Username || 'The President';
        
        const modifyNotification = `${presidentName} has changed your managed department from "${oldDeptName}" to "${newDeptName}".`;
        
        await pool.query(
            `INSERT INTO "Notification" (
                "Details_notification", 
                "Type_notification", 
                "Status_notification", 
                "Sender", 
                "UserID",
                "Time"
            ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
            [
                modifyNotification,
                'Role Modification',
                'Unread',
                presidentName,
                userId
            ]
        );
        
        res.json({ success: true, message: 'Manager modified successfully' });
            
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Error modifying manager:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.put('/api/club/change-vice-president', async (req, res) => {
    const { presidentId, newVicePresidentId } = req.body;
    
    try {
        const isLeader = await isClubLeadership(presidentId);
        if (!isLeader) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        const userCheck = await pool.query(
            'SELECT "UserID", "Username", "Role" FROM "Users" WHERE "UserID" = $1',
            [newVicePresidentId]
        );
        
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        const currentRole = userCheck.rows[0].Role || '';
        
        if (currentRole === 'none') {
            return res.status(400).json({ 
                success: false, 
                message: 'The user must be a club member first. They need to submit a join request and be approved.' 
            });
        }
        
        if (currentRole === 'president') {
            return res.status(400).json({ 
                success: false, 
                message: 'The President cannot be appointed as Vice President.' 
            });
        }
        
        const currentVP = await pool.query(
            'SELECT "UserID" FROM "Vice_President" WHERE "ClubID" = 1'
        );
        
        await pool.query('BEGIN');
        
        if (currentVP.rows.length > 0) {
            const oldVPId = currentVP.rows[0].UserID;
            
            await pool.query('DELETE FROM "Vice_President" WHERE "UserID" = $1', [oldVPId]);
            
            const isInstructor = await pool.query(
                'SELECT "UserID" FROM "Instructor" WHERE "UserID" = $1',
                [oldVPId]
            );
            
            if (isInstructor.rows.length === 0) {
                await pool.query('DELETE FROM "Member" WHERE "UserID" = $1', [oldVPId]);
            }
            
            await pool.query(
                'UPDATE "Users" SET "Role" = $1, "DepartmentID" = 0 WHERE "UserID" = $2',
                ['none', oldVPId]
            );
            
            console.log(`✅ Old VP ${oldVPId} deactivated (role set to 'none')`);
        }
    
        if (currentRole === 'member') {
    
            await pool.query('DELETE FROM "Member" WHERE "UserID" = $1', [newVicePresidentId]);
            console.log(`✅ Removed ${newVicePresidentId} from Member table`);
        }
        
    
        else if (currentRole === 'instructor') {
    
            await pool.query('DELETE FROM "Instructor" WHERE "UserID" = $1', [newVicePresidentId]);
    
            await pool.query('DELETE FROM "Member" WHERE "UserID" = $1', [newVicePresidentId]);
            console.log(`✅ Removed ${newVicePresidentId} from Instructor and Member tables`);
        }
        
        else if (currentRole === 'manager') {
        
            await pool.query('DELETE FROM "Manager" WHERE "UserID" = $1', [newVicePresidentId]);
        
            await pool.query('DELETE FROM "Member" WHERE "UserID" = $1', [newVicePresidentId]);
            console.log(`✅ Removed ${newVicePresidentId} from Manager and Member tables`);
        }
        
        
        await pool.query(
            'UPDATE "Users" SET "Role" = $1, "DepartmentID" = 0 WHERE "UserID" = $2',
            ['vice president', newVicePresidentId]
        );
        
        await pool.query(
            'INSERT INTO "Vice_President" ("UserID", "ClubID") VALUES ($1, 1)',
            [newVicePresidentId]
        );
        
        await pool.query('COMMIT');
        
        const presidentInfo = await pool.query(
            'SELECT "Username" FROM "Users" WHERE "UserID" = $1',
            [presidentId]
        );
        const presidentName = presidentInfo.rows[0]?.Username || 'The President';
        
        await pool.query(
            `INSERT INTO "Notification" (
                "Details_notification", 
                "Type_notification", 
                "Status_notification", 
                "Sender", 
                "UserID",
                "Time"
            ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
            [
                `${presidentName} has appointed you as the new Vice President of the club. You are no longer associated with any specific department.`,
                'Role Assignment',
                'Unread',
                presidentName,
                newVicePresidentId
            ]
        );
        
        res.json({ success: true, message: 'Vice President changed successfully.' });
        
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Error changing vice president:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});


app.post('/api/club/resign-president', async (req, res) => {
    const { presidentId, reason } = req.body;
    
    try {

        const presidentCheck = await pool.query(
            `SELECT "UserID" FROM "President" WHERE "UserID" = $1`,
            [presidentId]
        );
        
        if (presidentCheck.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'You are not the President' });
        }
        
        await pool.query(`DELETE FROM "President" WHERE "UserID" = $1`, [presidentId]);
        await pool.query(
            `UPDATE "Users" SET "Role" = 'none' WHERE "UserID" = $1`,
            [presidentId]
        );
        
        const notification = `You have resigned as President. ${reason ? `Reason: ${reason}` : 'Thank you for your service.'}`;
        await pool.query(
            `INSERT INTO "Notification" (
                "Details_notification", 
                "Type_notification", 
                "Status_notification", 
                "Sender", 
                "UserID",
                "Time"
            ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
            [
                notification,
                'Role Modification',
                'Unread',
                'System',
                presidentId
            ]
        );
        
        res.json({ success: true, message: 'You have resigned as President' });
        
    } catch (error) {
        console.error('Error resigning president:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});


app.post('/api/club/transfer-presidency', async (req, res) => {
    const { currentPresidentId, newPresidentUserId, reason } = req.body;
    
    try {
        const presidentCheck = await pool.query(
            `SELECT "UserID" FROM "President" WHERE "UserID" = $1`,
            [currentPresidentId]
        );
        
        if (presidentCheck.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'You are not the President' });
        }
        
        const userCheck = await pool.query(
            `SELECT "UserID", "Username", "Role" FROM "Users" WHERE "UserID" = $1`,
            [newPresidentUserId]
        );
        
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        const newUserRole = userCheck.rows[0].Role || '';
        const existingPresident = await pool.query(
            `SELECT "UserID" FROM "President" WHERE "UserID" = $1`,
            [newPresidentUserId]
        );
        
        if (existingPresident.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'User is already the President' });
        }
        
        await pool.query('BEGIN');
        
        if (newUserRole === 'member') {
        
            await pool.query('DELETE FROM "Member" WHERE "UserID" = $1', [newPresidentUserId]);
            console.log(`✅ Removed ${newPresidentUserId} from Member table`);
        }
        else if (newUserRole === 'instructor') {
        
            await pool.query('DELETE FROM "Instructor" WHERE "UserID" = $1', [newPresidentUserId]);
        
            await pool.query('DELETE FROM "Member" WHERE "UserID" = $1', [newPresidentUserId]);
            console.log(`✅ Removed ${newPresidentUserId} from Instructor and Member tables`);
        }
        else if (newUserRole === 'manager') {
         
            await pool.query('DELETE FROM "Manager" WHERE "UserID" = $1', [newPresidentUserId]);
         
            await pool.query('DELETE FROM "Member" WHERE "UserID" = $1', [newPresidentUserId]);
            console.log(`✅ Removed ${newPresidentUserId} from Manager and Member tables`);
        }
        
        else if (newUserRole === 'vice president') {
        
            await pool.query('DELETE FROM "Vice_President" WHERE "UserID" = $1', [newPresidentUserId]);
            console.log(`✅ Removed ${newPresidentUserId} from Vice_President table`);
        }
        
        await pool.query(
            'UPDATE "Users" SET "Role" = $1, "DepartmentID" = 0 WHERE "UserID" = $2',
            ['president', newPresidentUserId]
        );
        
        await pool.query(
            'INSERT INTO "President" ("UserID", "ClubID") VALUES ($1, 1)',
            [newPresidentUserId]
        );
        
        await pool.query(
            'UPDATE "Users" SET "Role" = $1, "DepartmentID" = 0 WHERE "UserID" = $2',
            ['none', currentPresidentId]
        );
        
        await pool.query('DELETE FROM "President" WHERE "UserID" = $1', [currentPresidentId]);
        await pool.query('DELETE FROM "Member" WHERE "UserID" = $1', [currentPresidentId]);
        await pool.query('DELETE FROM "Instructor" WHERE "UserID" = $1', [currentPresidentId]);
        await pool.query('DELETE FROM "Manager" WHERE "UserID" = $1', [currentPresidentId]);
        await pool.query('DELETE FROM "Vice_President" WHERE "UserID" = $1', [currentPresidentId]);
        
        await pool.query('COMMIT');
        
        const currentPresidentInfo = await pool.query(
            `SELECT "Username" FROM "Users" WHERE "UserID" = $1`,
            [currentPresidentId]
        );
        const currentPresidentName = currentPresidentInfo.rows[0]?.Username || 'The President';
        const newPresidentName = userCheck.rows[0].Username;
        const transferNotification = `${currentPresidentName} has transferred the presidency to you. ${reason ? `Reason: ${reason}` : ''}`;
        await pool.query(
            `INSERT INTO "Notification" (
                "Details_notification", 
                "Type_notification", 
                "Status_notification", 
                "Sender", 
                "UserID",
                "Time"
            ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
            [
                transferNotification,
                'Role Assignment',
                'Unread',
                currentPresidentName,
                newPresidentUserId
            ]
        );
        
        res.json({ success: true, message: `Presidency transferred to ${newPresidentName}` });
        
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Error transferring presidency:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

const crypto = require('crypto');
function generateResetToken() {
    return crypto.randomBytes(32).toString('hex');
}
app.post('/api/forgot-password', async (req, res) => {
    const { email, username } = req.body;
    
    if (!email || !username) {
        return res.status(400).json({ success: false, message: 'Email and username are required' });
    }
    
    try {

        const trimmedEmail = email.trim();
        let trimmedUsername = username.trim();
        

        if (!trimmedUsername.startsWith('@')) {
            trimmedUsername = '@' + trimmedUsername;
        }
        
        console.log(`Looking for: Email="${trimmedEmail}", Username="${trimmedUsername}"`);
        
        const userResult = await pool.query(
            `SELECT "UserID", "Username" FROM "Users" 
             WHERE TRIM(LOWER("Email")) = LOWER($1) 
             AND TRIM(LOWER("Username")) = LOWER($2)`,
            [trimmedEmail, trimmedUsername]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Invalid email or username. Please check and try again.'
            });
        }
        
        const user = userResult.rows[0];
        const resetToken = generateResetToken();
        const tokenExpiry = new Date();
        tokenExpiry.setHours(tokenExpiry.getHours() + 1);
        
        await pool.query(
            `UPDATE "Users" SET "reset_token" = $1, "token_expiry" = $2 WHERE "UserID" = $3`,
            [resetToken, tokenExpiry, user.UserID]
        );
        
        const resetLink = `http://localhost:3000/reset-password.html?token=${resetToken}&user=${user.UserID}`;
        
        res.json({ 
            success: true, 
            resetLink: resetLink
        });
        
    } catch (error) {
        console.error('Error in forgot password:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, userId, newPassword } = req.body;
    
    const passwordRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/;
    if (!newPassword || !passwordRegex.test(newPassword)) {
        return res.status(400).json({ 
            success: false, 
            message: 'Password must be at least 8 characters with at least one letter and one number' 
        });
    }
    
    try {
    
        const userResult = await pool.query(
            `SELECT "UserID", "reset_token", "token_expiry" FROM "Users" 
             WHERE "UserID" = $1 AND "reset_token" = $2`,
            [userId, token]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset link' });
        }
        
        const user = userResult.rows[0];
        const tokenExpiry = new Date(user.token_expiry);
        const now = new Date();
        
        if (now > tokenExpiry) {
            return res.status(400).json({ success: false, message: 'Reset link has expired. Please request a new one.' });
        }
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        await pool.query(
            `UPDATE "Users" SET "Password" = $1, "reset_token" = NULL, "token_expiry" = NULL WHERE "UserID" = $2`,
            [hashedPassword, userId]
        );
        
        res.json({ success: true, message: 'Password reset successfully! You can now login with your new password.' });
        
    } catch (error) {
        console.error('Error resetting password:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});