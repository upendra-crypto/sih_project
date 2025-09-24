// =================================================================
// 1. SETUP & IMPORTS
// =================================================================
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const cors = require('cors');

// Load environment variables from .env file
dotenv.config();

const app = express();

// =================================================================
// 2. DATABASE CONNECTION
// =================================================================
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB Connected...');
  } catch (err) {
    console.error('MongoDB Connection Error:', err.message);
    process.exit(1); // Exit process with failure
  }
};
connectDB();

// =================================================================
// 3. DATABASE MODELS (SCHEMAS)
// =================================================================

// User Schema
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['pilgrim', 'admin', 'staff'], default: 'pilgrim' },
  accessibilityNeeds: {
    isDifferentlyAbled: { type: Boolean, default: false },
    isSeniorCitizen: { type: Boolean, default: false },
  },
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

// Temple Schema
const TempleSchema = new mongoose.Schema({
  name: { type: String, required: true },
  location: { type: String, required: true },
  currentCrowdLevel: { type: String, enum: ['Low', 'Medium', 'High', 'Very High'], default: 'Low' },
  estimatedWaitTime: { type: Number, default: 15 }, // in minutes
}, { timestamps: true });

const Temple = mongoose.model('Temple', TempleSchema);

// Darshan Booking Schema
const DarshanBookingSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  temple: { type: mongoose.Schema.Types.ObjectId, ref: 'Temple', required: true },
  slotTime: { type: Date, required: true },
  status: { type: String, enum: ['Booked', 'Completed', 'Cancelled'], default: 'Booked' },
  qrCode: { type: String, required: true, unique: true },
}, { timestamps: true });

const DarshanBooking = mongoose.model('DarshanBooking', DarshanBookingSchema);

// Crowd Data Schema (for IoT/AI analytics)
const CrowdDataSchema = new mongoose.Schema({
    temple: { type: mongoose.Schema.Types.ObjectId, ref: 'Temple', required: true },
    crowdCount: { type: Number, required: true },
    source: { type: String, required: true }, // e.g., 'CCTV-Gate1', 'Drone-View'
}, { timestamps: true });

const CrowdData = mongoose.model('CrowdData', CrowdDataSchema);

// Emergency Alert Schema
const EmergencyAlertSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    location: {
        latitude: { type: String, required: true },
        longitude: { type: String, required: true },
    },
    alertType: { type: String, enum: ['Medical', 'Security', 'Lost'], default: 'Medical' },
    status: { type: String, enum: ['New', 'Acknowledged', 'Resolved'], default: 'New' },
}, { timestamps: true });

const EmergencyAlert = mongoose.model('EmergencyAlert', EmergencyAlertSchema);


// =================================================================
// 4. AUTHENTICATION MIDDLEWARE
// =================================================================
const authMiddleware = (req, res, next) => {
  const token = req.header('x-auth-token');
  if (!token) {
    return res.status(401).json({ msg: 'No token, authorization denied' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded.user;
    next();
  } catch (err) {
    res.status(401).json({ msg: 'Token is not valid' });
  }
};


// =================================================================
// 5. API LOGIC (CONTROLLERS) & ROUTES
// =================================================================
app.use(cors());
app.use(express.json()); // Middleware to parse JSON bodies

// --- Health Check Route ---
app.get('/', (req, res) => res.send('Pilgrimage Management API is running...'));

// --- Authentication Routes ---
// Register a new user
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ msg: 'User already exists' });
    }
    user = new User({ name, email, password });
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);
    await user.save();

    const payload = { user: { id: user.id } };
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '5h' }, (err, token) => {
      if (err) throw err;
      res.status(201).json({ token });
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// Login user
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    let user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ msg: 'Invalid Credentials' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ msg: 'Invalid Credentials' });
    }
    const payload = { user: { id: user.id } };
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '5h' }, (err, token) => {
      if (err) throw err;
      res.json({ token });
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// --- Temple Information Routes ---
// Get all temples with their current status
app.get('/api/temples', async (req, res) => {
    try {
        const temples = await Temple.find();
        res.json(temples);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});


// --- Booking & Virtual Queue Routes ---
// Create a new darshan booking
app.post('/api/bookings', authMiddleware, async (req, res) => {
  const { templeId, slotTime } = req.body;
  try {
    const newBooking = new DarshanBooking({
      user: req.user.id,
      temple: templeId,
      slotTime: new Date(slotTime),
      qrCode: `QR-${Date.now()}-${req.user.id}`,
    });
    const booking = await newBooking.save();
    res.status(201).json(booking);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Get bookings for the logged-in user
app.get('/api/bookings', authMiddleware, async (req, res) => {
  try {
    const bookings = await DarshanBooking.find({ user: req.user.id }).populate('temple', ['name', 'location']);
    res.json(bookings);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// --- Data Ingestion Routes (for IoT/AI) ---
// Ingest crowd data from a sensor/camera
app.post('/api/data/crowd', async (req, res) => {
    const { templeId, crowdCount, crowdLevel, source } = req.body;
    try {
        await CrowdData.create({ temple: templeId, crowdCount, source });
        await Temple.findByIdAndUpdate(templeId, { currentCrowdLevel: crowdLevel });
        // In a real app, you would emit a WebSocket event here to update all clients
        res.status(200).json({ msg: 'Crowd data ingested successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// --- Emergency Alert Route ---
// Trigger a panic alert
app.post('/api/alerts/panic', authMiddleware, async (req, res) => {
    const { latitude, longitude, alertType } = req.body;
    try {
        const newAlert = new EmergencyAlert({
            user: req.user.id,
            location: { latitude, longitude },
            alertType: alertType || 'Medical',
        });
        await newAlert.save();
        // Here, you would trigger a real-time notification to admin/staff dashboards
        res.status(201).json({ msg: 'Alert raised successfully. Help is on the way.' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// =================================================================
// 6. START THE SERVER
// =================================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));