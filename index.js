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
const commentsCollection = database.collection("comments");
const usersCollection = database.collection("user");
const favoritesCollection = database.collection("favorites");
const planCollection = database.collection('plans');
const subscriptionCollection = database.collection('subscriptions');
const sessionCollection = database.collection('session');
const reportsCollection = database.collection('reports');


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

// comments related endpoints
app.get('/api/comments', async (req, res) => {
    const query = {};
    if (req.query.lessonId) {
        query.lessonId = req.query.lessonId;
    }
    const cursor = commentsCollection.find(query);
    const result = await cursor.toArray();
    res.send(result);
});

app.post('/api/comments', async (req, res) => {
    const comment = req.body;
    const newComment = {
        ...comment,
        createdAt: new Date()
    };
    const result = await commentsCollection.insertOne(newComment);
    res.send(result);
});

// reports related endpoints
app.post('/api/reports', verifyToken, async (req, res) => {
    const report = req.body;
    const newReport = {
        ...report,
        userId: req.user._id.toString(),
        userName: req.user.name,
        userEmail: req.user.email,
        createdAt: new Date()
    };
    const result = await reportsCollection.insertOne(newReport);
    res.send(result);
});

app.get('/api/reports', verifyToken, verifyAdmin, async (req, res) => {
    const reports = await reportsCollection.find({}).toArray();

    // Populate lesson details
    const populated = [];
    for (const report of reports) {
        let lesson = null;
        try {
            lesson = await lessonsCollection.findOne({ _id: new ObjectId(report.lessonId) });
        } catch (e) {
            lesson = await lessonsCollection.findOne({ _id: report.lessonId });
        }
        populated.push({
            ...report,
            lessonTitle: lesson ? lesson.title : 'Deleted Lesson',
            lessonAuthor: lesson ? (lesson.authorName || lesson.author?.name || 'Unknown') : 'Unknown'
        });
    }
    res.send(populated);
});

app.delete('/api/reports/:id', verifyToken, verifyAdmin, async (req, res) => {
    const id = req.params.id;
    const result = await reportsCollection.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
});

// delete lesson endpoint
app.delete('/api/lessons/:id', verifyToken, async (req, res) => {
    const id = req.params.id;
    const filter = { _id: new ObjectId(id) };

    const lesson = await lessonsCollection.findOne(filter);
    if (!lesson) {
        return res.status(404).send({ error: 'Lesson not found' });
    }
    if (req.user.role !== 'admin' && lesson.authorEmail !== req.user.email) {
        return res.status(403).send({ error: 'Forbidden' });
    }

    const result = await lessonsCollection.deleteOne(filter);
    // Delete any associated reports
    await reportsCollection.deleteMany({ lessonId: id });
    res.send(result);
});

// like toggling
app.post('/api/lessons/:id/like', verifyToken, async (req, res) => {
    const id = req.params.id;
    const userId = req.user._id.toString();
    const filter = { _id: new ObjectId(id) };

    const lesson = await lessonsCollection.findOne(filter);
    if (!lesson) {
        return res.status(404).send({ error: 'Lesson not found' });
    }

    const likes = lesson.likes || [];
    let updateDoc;

    if (likes.includes(userId)) {
        updateDoc = { $pull: { likes: userId } };
    } else {
        updateDoc = { $addToSet: { likes: userId } };
    }

    const result = await lessonsCollection.updateOne(filter, updateDoc);
    res.send(result);
});

// my lessons endpoint
app.get('/api/my/lessons', verifyToken, async (req, res) => {
    const query = { authorEmail: req.user.email };
    const cursor = lessonsCollection.find(query);
    const result = await cursor.toArray();
    res.send(result);
});

// update lesson 
app.patch('/api/lessons/:id', verifyToken, async (req, res) => {
    const id = req.params.id;
    const updatedFields = req.body;
    const filter = { _id: new ObjectId(id) };

    // If not admin, verify ownership
    const lesson = await lessonsCollection.findOne(filter);
    if (!lesson) {
        return res.status(404).send({ error: 'Lesson not found' });
    }
    if (req.user.role !== 'admin' && lesson.authorEmail !== req.user.email) {
        return res.status(403).send({ error: 'Forbidden' });
    }

    const updateDoc = {
        $set: {}
    };

    if (updatedFields.title !== undefined) updateDoc.$set.title = updatedFields.title;
    if (updatedFields.description !== undefined) updateDoc.$set.description = updatedFields.description;
    if (updatedFields.category !== undefined) updateDoc.$set.category = updatedFields.category;
    if (updatedFields.emotionalTone !== undefined) updateDoc.$set.emotionalTone = updatedFields.emotionalTone;
    if (updatedFields.coverImage !== undefined) updateDoc.$set.coverImage = updatedFields.coverImage;
    if (updatedFields.visibility !== undefined) updateDoc.$set.visibility = updatedFields.visibility;
    if (updatedFields.accessLevel !== undefined) updateDoc.$set.accessLevel = updatedFields.accessLevel;
    if (updatedFields.isFeatured !== undefined && req.user.role === 'admin') {
        updateDoc.$set.isFeatured = updatedFields.isFeatured;
    }

    const result = await lessonsCollection.updateOne(filter, updateDoc);
    res.send(result);
});



// favorites check (is a specific lesson favorited?)
app.get('/api/favorites/check', verifyToken, async (req, res) => {
    const { lessonId } = req.query;
    const userId = req.user._id.toString();
    const existing = await favoritesCollection.findOne({ userId, lessonId });
    res.send({ favorited: !!existing });
});

// favorites
app.get('/api/favorites', verifyToken, async (req, res) => {
    const query = { userId: req.user._id.toString() };
    const list = await favoritesCollection.find(query).toArray();

    // Populate lessons details
    const lessonIds = list.map(item => new ObjectId(item.lessonId));
    const lessons = await lessonsCollection.find({ _id: { $in: lessonIds } }).toArray();
    res.send(lessons);
});

app.post('/api/favorites', verifyToken, async (req, res) => {
    const { lessonId } = req.body;
    const userId = req.user._id.toString();
    const query = { userId, lessonId };

    const existing = await favoritesCollection.findOne(query);
    if (existing) {
        await favoritesCollection.deleteOne(query);
        return res.send({ favorited: false });
    } else {
        await favoritesCollection.insertOne({
            userId,
            lessonId,
            createdAt: new Date()
        });
        return res.send({ favorited: true });
    }
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
    try {
        const totalUsers = await usersCollection.countDocuments({});
        const totalLessons = await lessonsCollection.countDocuments({});
        const premiumUsers = await usersCollection.countDocuments({ plan: 'user_premium' });
        const totalRevenue = premiumUsers * 1500;
        const totalReports = await reportsCollection.countDocuments({});
        
        const publicLessons = await lessonsCollection.countDocuments({ visibility: 'public' });
        const privateLessons = await lessonsCollection.countDocuments({ visibility: 'private' });
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayLessons = await lessonsCollection.countDocuments({ createdAt: { $gte: today } });

        const activeContributors = await lessonsCollection.aggregate([
            {
                $group: {
                    _id: "$authorEmail",
                    name: { $first: "$authorName" },
                    avatar: { $first: "$authorAvatar" },
                    count: { $sum: 1 }
                }
            },
            { $sort: { count: -1 } },
            { $limit: 5 }
        ]).toArray();

        const lessonsByCategory = await lessonsCollection.aggregate([
            { $group: { _id: "$category", count: { $sum: 1 } } }
        ]).toArray();

        const userGrowth = await usersCollection.aggregate([
            {
                $project: {
                    createdAt: { $ifNull: ["$createdAt", new Date()] }
                }
            },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } }
        ]).toArray();

        const lessonGrowth = await lessonsCollection.aggregate([
            {
                $project: {
                    createdAt: { $ifNull: ["$createdAt", new Date()] }
                }
            },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } }
        ]).toArray();

        res.send({
            totalUsers,
            totalLessons,
            premiumUsers,
            totalRevenue,
            totalReports,
            publicLessons,
            privateLessons,
            todayLessons,
            activeContributors,
            lessonsByCategory,
            userGrowth,
            lessonGrowth
        });
    } catch (err) {
        console.error("Error computing admin stats:", err);
        res.status(500).send({ error: "Failed to compute stats" });
    }
});

// plans 
app.get('/api/plans', async (req, res) => {
    const query = {}
    if (req.query.plan_id) {
        query.id = req.query.plan_id
    }
    const plan = await planCollection.findOne(query);
    res.send(plan)
});

// subscription 
app.post('/api/subscriptions', async (req, res) => {
    const data = req.body;
    const subsInfo = {
        ...data,
        createdAt: new Date()
    }

    const result = await subscriptionCollection.insertOne(subsInfo);

    // update the user plan information
    const filter = { email: data.email };
    const updateDocument = {
        $set: {
            plan: data.planId,
        },
    };

    const updateResult = await usersCollection.updateOne(filter, updateDocument);
    res.send(updateResult);
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
