const mysql = require("mysql2");

const db = mysql.createConnection({
  host: "shortline.proxy.rlwy.net",
  user: "root",
  password: "gpeZePrarnXLVebvweGMQylRtcCvZBoW",   // paste from Railway
  database: "railway",
  port: 31125
});

db.connect((err) => {
  if (err) {
    console.log("DB ERROR:", err);
  } else {
    console.log("MySQL Connected ✅");
  }
});

module.exports = db;