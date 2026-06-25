const dns = require('node:dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const app = express();
const port = process.env.PORT || 5000;
require('dotenv').config();

app.use(cors());

// Stripe Webhook endpoint (defined before global json body parser)
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        const stripeLib = require('stripe')(process.env.STRIPE_SECRET_KEY);
        event = stripeLib.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const metadata = session.metadata;
        const planId = metadata?.planId || 'user_premium';
        const email = metadata?.email || session.customer_email;
        const userId = metadata?.userId;

        if (email || userId) {
            let user = null;
            if (userId) {
                user = await usersCollection.findOne({
                    $or: [
                        { id: userId },
                        { email: email }
                    ]
                });
            } else if (email) {
                user = await usersCollection.findOne({ email: email });
            }

            if (user) {
                await usersCollection.updateOne(
                    { _id: user._id },
                    { $set: { plan: planId, isPremium: planId === 'user_premium' } }
                );

                const existingSub = await subscriptionCollection.findOne({ sessionId: session.id });
                if (!existingSub) {
                    await subscriptionCollection.insertOne({
                        userId: user.id || user._id.toString(),
                        email: user.email,
                        planId: planId,
                        sessionId: session.id,
                        amount: session.amount_total ? session.amount_total / 100 : 1500,
                        status: 'active',
                        createdAt: new Date()
                    });
                }
                console.log(`Successfully upgraded user ${user.email} to ${planId} via Webhook`);
            }
        }
    }

    res.json({ received: true });
});

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
    let userQuery;

    if (userId instanceof ObjectId) {
        userQuery = {
            $or: [
                { _id: userId },
                { _id: userId.toString() }
            ]
        };
    } else if (typeof userId === 'string') {
        let queries = [{ _id: userId }];
        if (ObjectId.isValid(userId)) {
            queries.push({ _id: new ObjectId(userId) });
        }
        userQuery = { $or: queries };
    } else {
        userQuery = { _id: userId };
    }

    const user = await usersCollection.findOne(userQuery);
    if (!user) {
        return res.status(401).send({ message: 'unauthorized access' })
    }

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
        .find({ isFeatured: true, visibility: 'public' })
        .sort({ createdAt: -1 })
        .toArray();
    res.send(featuredLessons);
});

// Top Contributors endpoint for Homepage
app.get('/api/lessons/top-contributors', async (req, res) => {
    try {
        const contributors = await lessonsCollection.aggregate([
            { $match: { visibility: "public" } },
            {
                $group: {
                    _id: { $ifNull: ["$authorEmail", "$author.name"] },
                    name: { $first: { $ifNull: ["$authorName", "$author.name"] } },
                    avatar: { $first: { $ifNull: ["$authorAvatar", "$author.avatar"] } },
                    lessonsShared: { $sum: 1 },
                    email: { $first: "$authorEmail" }
                }
            },
            {
                $lookup: {
                    from: "user",
                    localField: "email",
                    foreignField: "email",
                    as: "userInfo"
                }
            },
            {
                $addFields: {
                    userObj: { $arrayElemAt: ["$userInfo", 0] }
                }
            },
            {
                $addFields: {
                    verified: {
                        $or: [
                            { $eq: ["$userObj.role", "admin"] },
                            { $eq: ["$userObj.plan", "user_premium"] },
                            { $in: ["$name", ["Marcus Chen", "Akiro Tanaka", "David Vance"]] }
                        ]
                    }
                }
            },
            { $sort: { lessonsShared: -1 } },
            { $limit: 4 }
        ]).toArray();

        res.send(contributors);
    } catch (error) {
        console.error("Error fetching top contributors:", error);
        res.status(500).send({ error: "Internal Server Error" });
    }
});

// Most Saved Lessons endpoint for Homepage
app.get('/api/lessons/most-saved', async (req, res) => {
    try {
        const mostSaved = await lessonsCollection.aggregate([
            {
                $match: {
                    visibility: "public"
                }
            },
            {
                $lookup: {
                    from: "favorites",
                    let: { lessonIdStr: { $toString: "$_id" } },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $eq: ["$lessonId", "$$lessonIdStr"]
                                }
                            }
                        }
                    ],
                    as: "favoritesData"
                }
            },
            {
                $addFields: {
                    savesCount: {
                        $add: [
                            { $ifNull: ["$saves", 0] },
                            { $size: "$favoritesData" }
                        ]
                    }
                }
            },
            { $sort: { savesCount: -1, createdAt: -1 } },
            { $limit: 3 }
        ]).toArray();

        res.send(mostSaved);
    } catch (error) {
        console.error("Error fetching most saved lessons:", error);
        res.status(500).send({ error: "Internal Server Error" });
    }
});

// Lessons endpoint with search, category filtering, and pagination support
app.get('/api/lessons', async (req, res) => {
    console.log('server side query:', req.query);
    const query = {};

    if (req.query.visibility && req.query.visibility !== 'all') {
        query.visibility = req.query.visibility;
    } else if (!req.query.visibility) {
        query.visibility = 'public';
    }

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

    // Determine sorting parameters
    let sortStage = { createdAt: -1 }; // default newest
    if (req.query.sortBy === 'oldest') {
        sortStage = { createdAt: 1 };
    } else if (req.query.sortBy === 'title-asc') {
        sortStage = { title: 1 };
    } else if (req.query.sortBy === 'title-desc') {
        sortStage = { title: -1 };
    } else if (req.query.sortBy === 'most-saved') {
        sortStage = { savesCount: -1, createdAt: -1 };
    } else if (req.query.sortBy === 'newest') {
        sortStage = { createdAt: -1 };
    }

    // Build aggregation pipeline to support "most-saved" sorting dynamically
    const pipeline = [
        { $match: query },
        {
            $lookup: {
                from: "favorites",
                let: { lessonIdStr: { $toString: "$_id" } },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $eq: ["$lessonId", "$$lessonIdStr"]
                            }
                        }
                    }
                ],
                as: "favoritesData"
            }
        },
        {
            $addFields: {
                savesCount: { $size: "$favoritesData" }
            }
        },
        { $project: { favoritesData: 0 } },
        { $sort: sortStage }
    ];

    // pagination related work
    if (req.query.page) {
        const page = parseInt(req.query.page);
        const perPage = parseInt(req.query.perPage) || 12;
        const skipItems = (page - 1) * perPage;

        const total = await lessonsCollection.countDocuments(query);
        pipeline.push({ $skip: skipItems });
        pipeline.push({ $limit: perPage });

        const lessons = await lessonsCollection.aggregate(pipeline).toArray();
        return res.send({ total, lessons });
    }

    const result = await lessonsCollection.aggregate(pipeline).toArray();
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

app.delete('/api/reports/lesson/:lessonId', verifyToken, verifyAdmin, async (req, res) => {
    const lessonId = req.params.lessonId;
    const result = await reportsCollection.deleteMany({ lessonId: lessonId });
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

    let likes = Array.isArray(lesson.likes) ? lesson.likes : [];
    let updateDoc;

    if (likes.includes(userId)) {
        updateDoc = { $set: { likes: likes.filter(uid => uid !== userId) } };
    } else {
        likes.push(userId);
        updateDoc = { $set: { likes: likes } };
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
    if (updatedFields.isReviewed !== undefined && req.user.role === 'admin') {
        updateDoc.$set.isReviewed = updatedFields.isReviewed;
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
    const usersWithCount = await Promise.all(users.map(async (usr) => {
        const count = await lessonsCollection.countDocuments({ authorEmail: usr.email });
        return {
            ...usr,
            lessonsCount: count
        };
    }));
    res.send(usersWithCount);
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

// admin delete user
app.delete('/api/admin/users/:id', verifyToken, verifyAdmin, async (req, res) => {

    const id = req.params.id;

    let query = { _id: id };
    let user = await usersCollection.findOne(query);
    if (!user) {
        query = { _id: new ObjectId(id) };
        user = await usersCollection.findOne(query);
    }

    if (!user) {
        return res.status(404).send({ error: 'User not found' });
    }

    // Prevent self deletion
    if (user.email === req.user.email) {
        return res.status(400).send({ error: 'You cannot delete your own admin account!' });
    }

    const result = await usersCollection.deleteOne(query);

    // Cascade delete: delete all lessons created by this user
    if (user.email) {
        await lessonsCollection.deleteMany({ authorEmail: user.email });
    }

    res.send(result);
});

// admin dashboard stats
app.get('/api/admin/stats', verifyToken, verifyAdmin, async (req, res) => {
    const totalUsers = await usersCollection.countDocuments({});
    const totalLessons = await lessonsCollection.countDocuments({});
    const premiumUsers = await usersCollection.countDocuments({ plan: 'user_premium' });
    const totalRevenue = premiumUsers * 1500;
    const totalReports = await reportsCollection.countDocuments({});

    const publicLessons = await lessonsCollection.countDocuments({ visibility: 'public' });
    const privateLessons = await lessonsCollection.countDocuments({ visibility: 'private' });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIsoString = today.toISOString();
    const todayLessons = await lessonsCollection.countDocuments({
        $or: [
            { createdAt: { $gte: today } },
            { createdAt: { $gte: todayIsoString } }
        ]
    });

    const activeContributors = await lessonsCollection.aggregate([
        { $match: { visibility: "public" } },
        {
            $group: {
                _id: { $ifNull: ["$authorEmail", "$author.name"] },
                name: { $first: { $ifNull: ["$authorName", "$author.name"] } },
                avatar: { $first: { $ifNull: ["$authorAvatar", "$author.avatar"] } },
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
                createdAtDate: {
                    $cond: {
                        if: { $eq: [{ $type: "$createdAt" }, "string"] },
                        then: { $dateFromString: { dateString: "$createdAt" } },
                        else: { $ifNull: ["$createdAt", new Date()] }
                    }
                }
            }
        },
        {
            $group: {
                _id: { $dateToString: { format: "%Y-%m", date: "$createdAtDate" } },
                count: { $sum: 1 }
            }
        },
        { $sort: { _id: 1 } }
    ]).toArray();

    const lessonGrowth = await lessonsCollection.aggregate([
        {
            $project: {
                createdAtDate: {
                    $cond: {
                        if: { $eq: [{ $type: "$createdAt" }, "string"] },
                        then: { $dateFromString: { dateString: "$createdAt" } },
                        else: { $ifNull: ["$createdAt", new Date()] }
                    }
                }
            }
        },
        {
            $group: {
                _id: { $dateToString: { format: "%Y-%m", date: "$createdAtDate" } },
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
            isPremium: data.planId === 'user_premium',
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