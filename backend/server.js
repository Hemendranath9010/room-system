const express = require("express");
const cors = require("cors");
const db = require("./db");
const workingDays = [1,2,3,4,5,6]; // Mon–Sat (0 = Sunday)

const app = express();

app.use(cors());
app.use(express.json());

console.log("SERVER STARTED ✅");

function generateWeeklySlots(daysAhead = 30){
console.log("Generating slots...");
  const timetable = {
    1: [["09:00:00","10:00:00"], ["10:00:00","11:00:00"], ["11:00:00","12:00:00"],],
    2: [ ["09:00:00","12:00:00"] ],
    3: [ ["10:00:00","13:00:00"] ],
    4: [ ["09:00:00","11:00:00"], ["11:00:00","13:00:00"] ],
    5: [ ["09:00:00","12:00:00"] ],
    6: [ ["09:00:00","11:00:00"] ]
  };

  db.query("SELECT id FROM rooms", (err, rooms)=>{
    if(err) return;

    const today = new Date();

    for(let i=0; i<daysAhead; i++){

      const d = new Date();
      d.setDate(today.getDate() + i);

      const day = d.getDay();

      if(!workingDays.includes(day)) continue;

      const dateStr = d.toISOString().split("T")[0];

      const daySlots = timetable[day];
      if(!daySlots) continue; // ✅ correct place

      rooms.forEach(r=>{

        daySlots.forEach(s=>{
          db.query(`
            INSERT IGNORE INTO room_slots (room_id, date, start_time, end_time, status)
            VALUES (?, ?, ?, ?, 'free')
          `, [r.id, dateStr, s[0], s[1]]);
        });

      });

    }

  });

}
app.get("/debug-slots", (req,res)=>{
  db.query("SELECT * FROM room_slots LIMIT 50", (err,data)=>{
    res.send(data);
  });
});
// ✅ GET ALL ROOMS
app.get("/rooms", (req, res) => {
  db.query("SELECT id, room_name, status FROM rooms", (err, result) => {
    if (err) return res.send({ success: false });
    res.send({ success: true, data: result });
  });
});

// ✅ SAFE DATE PARSER (FIXES YOUR MAIN BUG)
function parseDateTime(date, timeRange) {
  try {
    if (!date || !timeRange) return null;

    // ✅ convert DB date to JS Date
    const baseDate = new Date(date);

    if (isNaN(baseDate)) return null;

    const parts = timeRange.split(" - ");
    if (parts.length < 2) return null;

    const end = parts[1].trim(); // "12:00 PM"

    const [time, modifier] = end.split(" ");
    if (!time || !modifier) return null;

    let [hours, minutes] = time.replace(/\./g, ":").split(":").map(Number);

    if (modifier === "PM" && hours !== 12) hours += 12;
    if (modifier === "AM" && hours === 12) hours = 0;

    // ✅ set time into date
    baseDate.setHours(hours);
    baseDate.setMinutes(minutes);
    baseDate.setSeconds(0);

    return baseDate;

  } catch (err) {
    console.log("PARSE ERROR:", err);
    return null;
  }
}


// ✅ LOGIN
app.post("/login", (req, res) => {
  const { email, password } = req.body;

  db.query(
    "SELECT * FROM users WHERE email=? AND password=? AND status='active'",
    [email, password],
    (err, result) => {
      if (err) return res.send({ success: false });

      if (result.length > 0) {
        res.send({
          success: true,
          name: result[0].name,
          role: result[0].role,
          user_id: result[0].id
        });
      } else {
        res.send({ success: false, message: "Invalid credentials" });
      }
    }
  );
});


// ✅ SUBMIT EVENT
app.post("/submit-event", (req, res) => {

  const {
    event_name,
    event_type,
    event_date,
    time_slot,
    audience,
    room_type,
    user_id,
    equipment
  } = req.body;

  console.log("REQUEST:", req.body);

  // 🔥 DATE VALIDATION
  const selected = new Date(event_date);
  selected.setHours(0,0,0,0);

  const minDate = new Date();
  minDate.setDate(minDate.getDate() + 3);
  minDate.setHours(0,0,0,0);

  if(selected < minDate){
    return res.send({ success:false, message:"Booking must be at least 3 days in advance" });
  }

  // 🔥 TIME VALIDATION
  const now = new Date();
  const eventDateTime = parseDateTime(event_date, time_slot);

  if(!eventDateTime){
    return res.send({ success:false, message:"Invalid time format" });
  }

  if(eventDateTime < now){
    return res.send({ success:false, message:"Past time not allowed" });
  }

  // 🔥 TIME CONVERT
  function convertTo24(timeStr){
    let [time, mod] = timeStr.split(" ");
    let [h,m] = time.split(":").map(Number);

    if(mod === "PM" && h !== 12) h+=12;
    if(mod === "AM" && h === 12) h=0;

    return `${String(h).padStart(2,'0')}:${m}:00`;
  }

  const [startStr, endStr] = time_slot.split(" - ");
  const startSQL = convertTo24(startStr);
  const endSQL = convertTo24(endStr);

  // 🔥 FIND ROOMS
  const findRoom = `
    SELECT r.*, s.id AS slot_id, s.start_time, s.end_time
    FROM rooms r
    JOIN room_slots s ON r.id = s.room_id
    WHERE r.capacity >= ?
    AND r.status = 'available'
    AND s.date = ?
    AND s.status = 'free'
    AND TIME(s.start_time) <= ?
    AND TIME(s.end_time) >= ?
  `;

  db.query(findRoom, [audience, event_date, startSQL, endSQL], (err, rooms) => {

    if (err) {
      console.log("DB ERROR:", err);
      return res.send({ success:false });
    }

    if (rooms.length === 0) {
      return res.send({ success:false, message:"No free slots available" });
    }

    // 🔥 TIME IN MINUTES
    function toMinutes(t){
      let [time, mod] = t.split(" ");
      let [h,m] = time.split(":").map(Number);

      if(mod === "PM" && h !== 12) h+=12;
      if(mod === "AM" && h === 12) h=0;

      return h*60 + m;
    }

    const startMin = toMinutes(startStr);
    const endMin = toMinutes(endStr);

    // 🔥 GROUP ROOMS
    const roomMap = {};

    rooms.forEach(r=>{
      if(!roomMap[r.id]){
        roomMap[r.id] = {
          ...r,
          slots: []
        };
      }

      roomMap[r.id].slots.push({
        start: r.start_time,
        end: r.end_time,
        slot_id: r.slot_id
      });
    });

    // 🔥 FIND VALID ROOMS
    let validRooms = [];

    Object.values(roomMap).forEach(room=>{

      let slotRanges = room.slots.map(s=>{
        const [sh, sm] = s.start.split(":").map(Number);
        const [eh, em] = s.end.split(":").map(Number);

        return {
          id: s.slot_id,
          start: sh*60 + sm,
          end: eh*60 + em
        };
      });

      slotRanges.sort((a,b)=>a.start-b.start);

      let current = startMin;
      let usedSlots = [];

      for(let i=0;i<slotRanges.length;i++){
        if(slotRanges[i].start <= current && slotRanges[i].end > current){
          usedSlots.push(slotRanges[i].id);
          current = slotRanges[i].end;

          if(current >= endMin){
            validRooms.push({
              ...room,
              slot_ids: usedSlots
            });
            break;
          }
        }
      }

    });

    if(validRooms.length === 0){
      return res.send({success:false, message:"No matching free slot"});
    }

    // 🔥 EQUIPMENT FILTER
    validRooms = validRooms.filter(room => {

      if (!equipment || equipment.length === 0) return true;

      let roomEquip = [];

      try {
        roomEquip = typeof room.equipment === "string"
          ? JSON.parse(room.equipment)
          : room.equipment;
      } catch {
        roomEquip = [];
      }

      return equipment.every(e =>
        roomEquip.map(x => x.toLowerCase().trim()).includes(e.toLowerCase().trim())
      );
    });

    if(validRooms.length === 0){
      return res.send({success:false, message:"No room with required equipment"});
    }

    // 🔥 SELECT BEST ROOM
    validRooms.sort((a,b)=>a.capacity-b.capacity);
    const room = validRooms[0];
    const slotsToBook = room.slot_ids;

    // 🔥 UPDATE SLOTS
    db.query(
      "UPDATE room_slots SET status='booked' WHERE id IN (?) AND status='free'",
      [slotsToBook],
      (err2, result2) => {

        if (err2) {
          console.log(err2);
          return res.send({ success:false });
        }

        if (result2.affectedRows === 0){
          return res.send({ success:false, message:"Slot already taken" });
        }

        // 🔥 INSERT EVENT
        db.query(
          "INSERT INTO events (user_id,event_name,event_type,event_date,time_slot,audience,room_type) VALUES (?,?,?,?,?,?,?)",
          [user_id, event_name, event_type, event_date, time_slot, audience, room_type],
          (err3, result3) => {

            if (err3) {
              console.log(err3);
              return res.send({ success:false });
            }

            const event_id = result3.insertId;

            // 🔥 INSERT MULTIPLE BOOKINGS
            let pending = slotsToBook.length;

            slotsToBook.forEach(slot_id => {

              db.query(
                "INSERT INTO bookings (event_id,room_id,date,time_slot,slot_id) VALUES (?,?,?,?,?)",
                [event_id, room.id, event_date, time_slot, slot_id],
                (err4) => {

                  if (err4) {
                    console.log(err4);
                    return res.send({ success:false });
                  }

                  pending--;

                  if (pending === 0) {

                    const msg = `Event "${event_name}" booked in room ${room.room_name}`;

                    db.query("INSERT INTO notifications (user_id,message) VALUES (?,?)",[user_id,msg]);
                    db.query("INSERT INTO notifications (user_id,message) VALUES (?,?)",[0,msg]);

                    return res.send({
                      success:true,
                      room: room.room_name
                    });

                  }

                }
              );

            });

          }
        );

      }
    );

  });

});
// ✅ HISTORY (COMPLETED EVENTS)
app.get("/history", (req, res) => {
  const user_id = req.query.user_id;
  

  db.query(
    `SELECT e.event_name,e.event_date,e.time_slot,r.room_name
     FROM events e
     JOIN bookings b ON e.id=b.event_id
     JOIN rooms r ON b.room_id=r.id
     WHERE e.user_id=?`,
    [user_id],
    (err, result) => {
      if (err) return res.send({ success: false });

      const now = new Date();

      const completed = result.filter(e => {
  const dt = parseDateTime(e.event_date, e.time_slot);

  console.log("HISTORY:", e.event_date, e.time_slot, dt);

  if (!dt) return true;

  return dt < new Date();
});

      res.send({ success: true, data: completed });
    }
  );
});


// ✅ BOOKINGS (ACTIVE EVENTS)
app.get("/bookings", (req, res) => {
  const user_id = req.query.user_id;

  db.query(
    `SELECT e.event_name,
       e.event_date,
       e.time_slot,
       r.room_name,
       b.room_id,   -- ✅ ADD THIS
       b.id AS booking_id
     FROM events e
     JOIN bookings b ON e.id=b.event_id
     JOIN rooms r ON b.room_id=r.id
     WHERE e.user_id=?  `,
    [user_id],
    (err, result) => {
      if (err) {
  console.log("BOOKINGS ERROR:", err); // 👈 THIS WILL SHOW REAL ERROR
  return res.send({ success: false });
}

      const now = new Date();

      const active = result.filter(e => {
  const dt = parseDateTime(e.event_date, e.time_slot);

  console.log("BOOKING:", e.event_date, e.time_slot, dt);
  console.log("BOOKING RAW:", e.event_date, e.time_slot);

  if (!dt) {
  console.log("Invalid time format:", e.time_slot);
  return true; // ✅ DO NOT REMOVE booking
}

  return dt >= new Date();
});

      res.send({ success: true, data: active });
    }
  );
});


// ✅ NOTIFICATIONS
app.get("/notifications", (req, res) => {
  const user_id = req.query.user_id;

  db.query(
    "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC",
    [user_id],
    (err, result) => {
      if (err) return res.send({ success: false });
      res.send({ success: true, data: result });
    }
  );
});


// ✅ ADMIN EVENTS
app.get("/admin-events", (req,res)=>{

  const { date } = req.query;

  let query = `
    SELECT e.*, b.id AS booking_id, b.room_id, r.room_name
    FROM events e
    JOIN bookings b ON e.id = b.event_id
JOIN rooms r ON b.room_id = r.id
  `;

  let params = [];

  if(date){
    query += " WHERE DATE(e.event_date) = ?";
    params.push(date);
  }

  db.query(query, params, (err,result)=>{
    if(err) return res.send({success:false});
    res.send({success:true, data:result});
  });

});


// ✅ CANCEL EVENT
app.post("/cancel-event", (req,res)=>{

  const { event_id, user_id } = req.body;

  // 🔥 STEP 1: FREE ALL SLOTS (CORRECT WAY)
  db.query(`
    UPDATE room_slots s
    JOIN bookings b ON s.id = b.slot_id
    SET s.status='free'
    WHERE b.event_id=?
  `, [event_id], (err)=>{

    if(err){
      console.log(err);
      return res.send({success:false});
    }

    // 🔥 STEP 2: DELETE BOOKINGS
    db.query(
      "DELETE FROM bookings WHERE event_id=?",
      [event_id],
      (err2)=>{

        if(err2){
          console.log(err2);
          return res.send({success:false});
        }

        // 🔥 STEP 3: DELETE EVENT
        db.query(
          "DELETE FROM events WHERE id=?",
          [event_id],
          (err3)=>{

            if(err3){
              console.log(err3);
              return res.send({success:false});
            }

            // 🔥 STEP 4: NOTIFICATION
            db.query(
              "INSERT INTO notifications (user_id, message) VALUES (?, ?)",
              [user_id, "Your event has been cancelled"]
            );

            res.send({success:true});
          }
        );

      }
    );

  });

});

// ✅ CHANGE ROOM
app.post("/change-room", (req, res) => {

  const { booking_id, new_room_id } = req.body;

  // 🔥 GET EVENT DETAILS
  db.query(`
    SELECT b.room_id AS old_room_id, e.event_date, e.time_slot
    FROM bookings b
    JOIN events e ON b.event_id = e.id
    WHERE b.id=?
  `, [booking_id], (err, result) => {

    if (err || result.length === 0) {
      console.log(err);
      return res.send({ success: false });
    }

    const { event_date, time_slot } = result[0];

    // 🔥 FIND FREE SLOTS IN NEW ROOM
    db.query(`
      SELECT * FROM room_slots
      WHERE room_id=? AND date=? AND status='free'
    `, [new_room_id, event_date], (err2, slots) => {

      if (err2 || slots.length === 0) {
        return res.send({ success: false, message: "No free slot" });
      }

      // 🔥 TIME CONVERTER
      function toMinutes(t) {
        let [time, mod] = t.split(" ");
        let [h, m] = time.split(":").map(Number);

        if (mod === "PM" && h !== 12) h += 12;
        if (mod === "AM" && h === 12) h = 0;

        return h * 60 + m;
      }

      const [start, end] = time_slot.split(" - ");
      const startMin = toMinutes(start);
      const endMin = toMinutes(end);

      // 🔥 CONVERT SLOT TIMES
      const slotRanges = slots.map(s => {
        const [sh, sm] = s.start_time.split(":").map(Number);
        const [eh, em] = s.end_time.split(":").map(Number);

        return {
          id: s.id,
          start: sh * 60 + sm,
          end: eh * 60 + em
        };
      });

      slotRanges.sort((a, b) => a.start - b.start);

      let current = startMin;
      let usedSlots = [];

      // 🔥 FIND CONTINUOUS SLOT
      for (let i = 0; i < slotRanges.length; i++) {
        if (slotRanges[i].start <= current && slotRanges[i].end > current) {
          usedSlots.push(slotRanges[i].id);
          current = slotRanges[i].end;

          if (current >= endMin) break;
        }
      }

      if (current < endMin) {
        return res.send({ success: false, message: "No continuous slot" });
      }

      const slotsToBook = usedSlots;

      // 🔥 FREE OLD SLOT(S)
      db.query(`
        UPDATE room_slots 
        SET status='free' 
        WHERE id IN (
          SELECT slot_id FROM bookings WHERE id=?
        )
      `, [booking_id], () => {

        // 🔥 BOOK NEW SLOT(S)
        db.query(
          "UPDATE room_slots SET status='booked' WHERE id IN (?) AND status='free'",
          [slotsToBook],
          (err3, result3) => {

            if (err3 || result3.affectedRows === 0) {
              return res.send({ success: false, message: "Slot already taken" });
            }

            // 🔥 UPDATE BOOKING (use first slot)
            db.query(
              "UPDATE bookings SET room_id=?, slot_id=? WHERE id=?",
              [new_room_id, slotsToBook[0], booking_id],
              () => {
                res.send({ success: true });
              }
            );

          }
        );

      });

    });

  });

});
// ✅ CLEAR HISTORY (ONLY COMPLETED)
app.delete("/clear-history", (req, res) => {
  const user_id = req.query.user_id;

  db.query(
    `SELECT e.id, e.event_date, e.time_slot
     FROM events e
     WHERE e.user_id=?`,
    [user_id],
    (err, events) => {
      if (err) return res.send({ success: false });

      const now = new Date();

      const completedIds = events
        .filter(e => {
          const dt = parseDateTime(e.event_date, e.time_slot);
          return dt && dt < now;
        })
        .map(e => e.id);

      if (completedIds.length === 0) {
        return res.send({ success: true });
      }

      // 🔥 STEP 1: FREE SLOTS FIRST
db.query(`
  UPDATE room_slots s
JOIN bookings b ON s.id = b.slot_id
SET s.status='free'
WHERE b.event_id IN (?)
`, [completedIds], (err) => {

  if (err) return res.send({ success: false });

  // 🔥 STEP 2: DELETE BOOKINGS
  db.query(
    `DELETE FROM bookings WHERE event_id IN (?)`,
    [completedIds],
    (err2) => {

      if (err2) return res.send({ success: false });

      // 🔥 STEP 3: DELETE EVENTS
      db.query(
        `DELETE FROM events WHERE id IN (?)`,
        [completedIds],
        () => {
          res.send({ success: true });
        }
      );

    }
  );
});
});

});  // ✅ CLOSE clear-history API properly
// ✅ CLEAR NOTIFICATIONS
app.delete("/clear-notifications", (req, res) => {
  const user_id = req.query.user_id;

  db.query(
    "DELETE FROM notifications WHERE user_id=?",
    [user_id],
    () => {
      res.send({ success: true });
    }
  );
});


// ✅ START SERVER


// ✅ GET AVAILABLE ROOMS FOR GIVEN DATE & TIME
app.get("/available-rooms", (req, res) => {

  const { date, time_slot, current_room_id } = req.query;

  db.query(`
    SELECT r.id, r.room_name, r.capacity, r.room_type, r.status,
           s.id AS slot_id, s.start_time, s.end_time
    FROM rooms r
    JOIN room_slots s ON r.id = s.room_id
    WHERE r.status='available'
    AND s.date=?
    AND s.status='free'
  `,[date], (err, rows)=>{

    if(err) return res.send({success:false});

    function toMinutes(t){
      let [time, mod] = t.split(" ");
      let [h,m] = time.split(":").map(Number);

      if(mod === "PM" && h !== 12) h+=12;
      if(mod === "AM" && h === 12) h=0;

      return h*60 + m;
    }

    const [start, end] = time_slot.split(" - ");
    const startMin = toMinutes(start);
    const endMin = toMinutes(end);

    // 🔥 GROUP SLOTS BY ROOM
    const roomMap = {};

    rows.forEach(r => {

      if(Number(r.id) === Number(current_room_id)) return;

      if(!roomMap[r.id]){
        roomMap[r.id] = {
          id: r.id,
          room_name: r.room_name,
          capacity: r.capacity,
          room_type: r.room_type,
          slots: []
        };
      }

      roomMap[r.id].slots.push({
        start: r.start_time,
        end: r.end_time
      });

    });

    const freeRooms = [];

    // 🔥 CHECK CONTINUOUS COVERAGE
    Object.values(roomMap).forEach(room => {

      // convert slots to minutes
      let slotRanges = room.slots.map(s => {
        const [sh, sm] = s.start.split(":").map(Number);
        const [eh, em] = s.end.split(":").map(Number);

        return {
          start: sh*60 + sm,
          end: eh*60 + em
        };
      });

      // sort slots
      slotRanges.sort((a,b)=>a.start - b.start);

      let current = startMin;

      for(let i=0; i<slotRanges.length; i++){

        if(slotRanges[i].start <= current && slotRanges[i].end > current){
          current = slotRanges[i].end;

          if(current >= endMin){
            freeRooms.push(room);
            break;
          }
        }
      }

    });

    res.send({ success:true, data: freeRooms });

  });

});
// ✅ ADMIN DASHBOARD STATS
app.get("/admin-stats", (req, res) => {

  db.query("SELECT COUNT(*) AS total FROM events", (e1, r1) => {
    if (e1) return res.send({success:false});

    db.query("SELECT COUNT(*) AS today FROM events WHERE DATE(event_date)=CURDATE()", (e2, r2) => {
      if (e2) return res.send({success:false});

      db.query("SELECT COUNT(*) AS available FROM rooms WHERE status='available'", (e3, r3) => {
        if (e3) return res.send({success:false});

        res.send({
          success: true,
          total: r1[0].total,
          today: r2[0].today,
          available: r3[0].available
        });
      });
    });
  });

});



app.post("/toggle-room", (req, res) => {
  const { room_id, status } = req.body;

  db.query(
    "UPDATE rooms SET status=? WHERE id=?",
    [status, room_id],
    (err) => {
      if (err) return res.send({ success: false });
      res.send({ success: true });
    }
  );
});

app.post("/cancel-day", (req, res) => {

  const { date } = req.body;

  if(!date){
    return res.send({ success:false, message:"Date required" });
  }

  // 🔥 STEP 1: GET ALL BOOKINGS
  db.query(`
    SELECT s.id AS slot_id
FROM bookings b
JOIN room_slots s ON s.id = b.slot_id
WHERE s.date=?
  `,[date], (err, slots)=>{

    if(err) return res.send({ success:false });

    // 🔥 STEP 2: FREE ALL SLOTS
   let pending = slots.length;

if(pending === 0) proceedDelete();

slots.forEach(s=>{
  db.query("UPDATE room_slots SET status='free' WHERE id=?", [s.slot_id], ()=>{
    pending--;
    if(pending === 0){
      proceedDelete();
    }
  });
});

function proceedDelete(){
  db.query("DELETE FROM bookings WHERE DATE(date)=?", [date], ()=>{
    db.query("DELETE FROM events WHERE DATE(event_date)=?", [date], ()=>{
      res.send({ success:true });
    });
  });
}
});  // closes db.query
});  // closes app.post("/cancel-day")
app.get("/users", (req, res) => {
  db.query(
    "SELECT id, name, email, role, status FROM users WHERE role != 'admin'",
    (err, result) => {
      if (err) return res.send({ success: false });
      res.send({ success: true, data: result });
    }
  );
});

app.post("/toggle-user", (req, res) => {

  const { user_id, status } = req.body;

  db.query(
    "UPDATE users SET status=? WHERE id=?",
    [status, user_id],
    (err) => {
      if (err) return res.send({ success: false });
      res.send({ success: true });
    }
  );

});

app.delete("/delete-user/:id", (req, res) => {

  const id = req.params.id;

  // 🔥 STEP 0: FREE ALL SLOTS OF THIS USER'S EVENTS
db.query(`
  UPDATE room_slots s
JOIN bookings b ON s.id = b.slot_id
JOIN events e ON e.id = b.event_id
SET s.status='free'
WHERE e.user_id = ?
`, [id], (err0) => {

  if (err0) return res.send({ success: false });

  // 🔥 STEP 1: DELETE BOOKINGS
  db.query(`
    DELETE b FROM bookings b
    JOIN events e ON b.event_id = e.id
    WHERE e.user_id = ?
  `, [id], (err1) => {

    if (err1) return res.send({ success: false });

    // 🔥 STEP 2: DELETE EVENTS
    db.query("DELETE FROM events WHERE user_id=?", [id], (err2) => {

      if (err2) return res.send({ success: false });

      // 🔥 STEP 3: DELETE USER
      db.query("DELETE FROM users WHERE id=?", [id], (err3) => {

        if (err3) return res.send({ success: false });

        res.send({ success: true });

      });

    });

  });

});
}); // ✅ CLOSE app.delete("/delete-user")

app.get("/can-change-room", (req,res)=>{

  const { booking_id } = req.query;

  db.query(
    `SELECT e.event_date, e.time_slot
     FROM events e
     JOIN bookings b ON e.id=b.event_id
     WHERE b.id=?`,
    [booking_id],
    (err,result)=>{

      if(err || result.length===0){
        return res.send({success:false});
      }

      const eventDateTime = parseDateTime(
        result[0].event_date,
        result[0].time_slot
      );

      const now = new Date();
      const diffHours = (eventDateTime - now) / (1000*60*60);

      if(diffHours <= 500 && diffHours > 0){
        return res.send({success:true, allow:true});
      }else{
        return res.send({success:true, allow:false}); // ✅ FIXED
      }

    }
  );
});

app.post("/report-issue",(req,res)=>{

  const { booking_id, user_id } = req.body;

  db.query(
    `SELECT e.event_name, r.room_name, u.name
     FROM events e
     JOIN bookings b ON e.id=b.event_id
     JOIN rooms r ON b.room_id=r.id
     JOIN users u ON u.id=?
     WHERE b.id=?`,
    [user_id, booking_id],
    (err,result)=>{

      if(result && result.length>0){

        const e = result[0];

        const msg = `
⚠️ Room Issue Reported
User: ${e.name}
Event: ${e.event_name}
Room: ${e.room_name}
`;

        // notify admin
        db.query(
          "INSERT INTO notifications (user_id,message) VALUES (?,?)",
          [0,msg]
        );

      }

      res.send({success:true});
    }
  );

});

function cleanOldSlots(){
  const today = new Date().toISOString().split("T")[0];

  db.query("DELETE FROM room_slots WHERE date < ?", [today]);
}

generateWeeklySlots(60); // generate for next 60 days
setInterval(()=>{
  generateWeeklySlots(30);
}, 24 * 60 * 60 * 1000); // every day
app.listen(5000, () => {
  console.log("Server running on 5000 🔥");
});