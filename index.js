const dns = require('node:dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;
require('dotenv').config();


app.use(cors());


app.use(express.json());

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

app.get('/', (req, res) => {
    res.send('Hello World!')
});

const logger = (req, res, next) => {
    console.log('logger middleware logged', req.params);
    next();
};

const uri = process.env.AUTH_DB_URI || process.env.MONGO_DB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

client.connect(() => {
    console.log('connecting to MongoDB');
}).catch(console.dir);

// Setup database collections
const database = client.db("lexmora_db");
const lessonsCollection = database.collection("lessons");


// verification related middleware
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers?.authorization;
    if (!authHeader) {
        return res.status(401).send({ message: 'unauthorized access' })
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).send({ message: 'unauthorized access' })
    }

    const query = { token: token };
    const session = await sessionCollection.findOne(query);

    if (!session) {
        return res.status(401).send({ message: 'unauthorized access' })
    }

    const userId = session.userId;
    const userQuery = {
        _id: userId
    };

    const user = await usersCollection.findOne(userQuery);
    if (!user) {
        return res.status(401).send({ message: 'unauthorized access' })
    }
    // set data in the req object
    req.user = user;
    next();
};

const verifyUser = async (req, res, next) => {
    if (req.user?.role !== 'user') {
        return res.status(403).send({ message: 'forbidden access' })
    }
    next();
};

const verifyAdmin = async (req, res, next) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' })
    }
    next();
};

// Featured Lessons endpoint for Homepage
app.get('/api/lessons/featured', async (req, res) => {
    const featuredLessons = await lessonsCollection
        .find({ isFeatured: true })
        .sort({ createdAt: -1 })
        .toArray();
    res.send(featuredLessons);
});

// Lessons endpoint with search, category filtering, and pagination support
app.get('/api/lessons', async (req, res) => {
    console.log('server side query:', req.query);
    const query = {};

    if (req.query.search) {
        query.$or = [
            { title: { $regex: req.query.search, $options: 'i' } },
            { description: { $regex: req.query.search, $options: 'i' } }
        ];
    }

    if (req.query.category && req.query.category.toLowerCase() !== 'all') {
        query.category = { $regex: new RegExp(`^${req.query.category}$`, 'i') };
    }

    if (req.query.emotionalTone && req.query.emotionalTone.toLowerCase() !== 'all') {
        query.emotionalTone = { $regex: new RegExp(`^${req.query.emotionalTone}$`, 'i') };
    }

    // pagination related work
    if (req.query.page) {
        const page = parseInt(req.query.page);
        const perPage = parseInt(req.query.perPage) || 12;
        const skipItems = (page - 1) * perPage;

        const total = await lessonsCollection.countDocuments(query);
        const cursor = lessonsCollection.find(query).skip(skipItems).limit(perPage);
        const lessons = await cursor.toArray();
        return res.send({ total, lessons });
    }

    const cursor = lessonsCollection.find(query);
    const result = await cursor.toArray();
    res.send(result);
});

app.get('/api/lessons/:id', async (req, res) => {
    const id = req.params.id;
    const query = {
        _id: new ObjectId(id)
    };
    const result = await lessonsCollection.findOne(query);
    res.send(result);
});

app.post('/api/lessons', async (req, res) => {
    const lesson = req.body;
    const newLesson = {
        ...lesson,
        createdAt: new Date()
    };
    const result = await lessonsCollection.insertOne(newLesson);
    res.send(result);
});



// admin users list
app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
    const users = await usersCollection.find({}).toArray();
    res.send(users);
});

// admin update user
app.patch('/api/admin/users/:id', verifyToken, verifyAdmin, async (req, res) => {
    const id = req.params.id;
    const { role, plan } = req.body;
    
    // Check if user ID is ObjectId or string
    let query = { _id: id };
    let user = await usersCollection.findOne(query);
    if (!user) {
        query = { _id: new ObjectId(id) };
        user = await usersCollection.findOne(query);
    }

    if (!user) {
        return res.status(404).send({ error: 'User not found' });
    }

    const updateDoc = { $set: {} };
    if (role !== undefined) updateDoc.$set.role = role;
    if (plan !== undefined) updateDoc.$set.plan = plan;

    const result = await usersCollection.updateOne(query, updateDoc);
    res.send(result);
});

// admin dashboard stats
app.get('/api/admin/stats', verifyToken, verifyAdmin, async (req, res) => {
    const totalUsers = await usersCollection.countDocuments({});
    const totalLessons = await lessonsCollection.countDocuments({});
    
    // Total premium users
    const premiumUsers = await usersCollection.countDocuments({ plan: 'user_premium' });
    
    // Sum revenue from Stripe sessions (assuming 1500 per subscription)
    const totalRevenue = premiumUsers * 1500;

    res.send({
        totalUsers,
        totalLessons,
        premiumUsers,
        totalRevenue
    });
});

// Global Async Error Handler Middleware
app.use((err, req, res, next) => {
    console.error('Express global error:', err);
    res.status(500).send({ error: 'Internal Server Error' });
});

app.listen(port, () => {
    console.log(`Lexmora server listening on port ${port}`)
});

module.exports = app;
