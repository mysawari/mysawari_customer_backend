const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://admintech_db_user:8ecIxuNvrEengCuh@cluster0.9vpt6zf.mongodb.net/data').then(async () => {
  const db = mongoose.connection.db;
  const offers = await db.collection('offers').find({}).toArray();
  console.log(JSON.stringify(offers, null, 2));
  process.exit(0);
});
