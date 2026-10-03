const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://mysawari:F7hT17rSXYq94ZtV@cluster0.p7x7x.mongodb.net/mysawari?retryWrites=true&w=majority', { useNewUrlParser: true, useUnifiedTopology: true })
.then(async () => {
  const handover = await mongoose.connection.db.collection('handovers').findOne({});
  console.log(JSON.stringify(handover.vehicle, null, 2));
  process.exit(0);
});
