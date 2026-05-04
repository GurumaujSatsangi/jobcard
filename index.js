import express from "express";
import bodyParser from "body-parser";
import { Session } from "express-session";
import { Client } from "pg";
import ejs from "ejs";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import cookie from "cookie";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));
app.use(cookieParser()); // Required to parse incoming cookies

const transporter = nodemailer.createTransport({
  host: "smtp.example.com",
  port: 587,
  secure: false, // use STARTTLS (upgrade connection to TLS after connecting)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const dbHost =
  process.env.DB_HOST === "postgres" ? "localhost" : process.env.DB_HOST;
const dbPort = Number(process.env.DB_PORT || 5432);

const client = new Client({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: dbHost,
  port: dbPort,
  database: process.env.DB_NAME,
});

await client.connect();

async function checkAuth(req, res, next) {
  const token = req.cookies?.auth_token;

  if (!token) {
    return res.redirect("/");
  }

  try {
    const decodedUser = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decodedUser;

    next();
  } catch (error) {
    console.error("Invalid token:", error.message);
    res.clearCookie("auth_token");
    return res.redirect("/");
  }
}


async function checkTechAuth(req, res, next) {
  const token = req.cookies?.tech_auth_token;

  if (!token) {
    return res.redirect("/login/technician");
  }

  try {
    const decodedUser = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decodedUser;

    next();
  } catch (error) {
    console.error("Invalid token:", error.message);
    res.clearCookie("tech_auth_token");
    return res.redirect("/login/technician");
  }
}

// Pass 'res' so the function can set the cookie
async function UserLogin(employee_id, password, res) {
  const user = await client.query(
    "SELECT employee_id, hashed_password FROM users WHERE employee_id = $1",
    [employee_id],
  );

  if (user.rowCount === 0) return false;

  const isValidPassword = await bcrypt.compare(
    password,
    user.rows[0].hashed_password,
  );

  // Only generate token and cookie if password is correct
  if (isValidPassword) {
    const token = jwt.sign(
      {
        employee_id: user.rows[0].employee_id,
      },
      process.env.JWT_SECRET,
    );

    res.cookie("auth_token", token, {
      // Added name 'auth_token'
      maxAge: 900000,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
  }

  return isValidPassword;
}


async function TechnicianLogin(technician_id, password, res) {
  const user = await client.query(
    "SELECT * FROM technicians WHERE technician_id = $1",
    [technician_id],
  );

  if (user.rowCount === 0) return false;

  const isValidPassword = await bcrypt.compare(
    password,
    user.rows[0].hashed_password,
  );

  // Only generate token and cookie if password is correct
  if (isValidPassword) {
    const token = jwt.sign(
      {
        technician_id: user.rows[0].technician_id,
        technician_name:user.rows[0].technician_name,
      },
      process.env.JWT_SECRET,
    );

    res.cookie("tech_auth_token", token, {
      // Added name 'auth_token'
      maxAge: 900000,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
  }

  return isValidPassword;
}


async function StoreLogin(technician_id, password, res) {
  const user = await client.query(
    "SELECT * FROM technicians WHERE technician_id = $1",
    [technician_id],
  );

  if (user.rowCount === 0) return false;

  const isValidPassword = await bcrypt.compare(
    password,
    user.rows[0].hashed_password,
  );

  // Only generate token and cookie if password is correct
  if (isValidPassword) {
    const token = jwt.sign(
      {
        technician_id: user.rows[0].technician_id,
        technician_name:user.rows[0].technician_name,
      },
      process.env.JWT_SECRET,
    );

    res.cookie("tech_auth_token", token, {
      // Added name 'auth_token'
      maxAge: 900000,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
  }

  return isValidPassword;
}


app.get("/delete/:id", checkAuth, async (req, res) => {
  const data = await client.query("delete from applications where arn = $1 ", [
    req.params.id,
  ]);

  if (data) {
    return res.render("message.ejs",{message:"ONLINE JOB CARD APPLICATION WITH ARN: "+req.params.id+" HAS BEEN DELETED !"});
  }
});

app.get("/", async (req, res) => {
  return res.render("login.ejs");
});

app.get("/home", checkAuth, async (req, res) => {
  const employeeId = req.user.empid ?? req.user.employee_id;

  if (!employeeId) {
    res.clearCookie("auth_token");
    return res.redirect("/");
  }

  const mysubmissions = await client.query(
    "select * from applications where indentor=$1",
    [employeeId],
  );

  const myacs = await client.query(
    "select * from ac_database where $1=any(assigned_to)",
    [employeeId],
  );
  return res.render("home.ejs", { mysubmissions: mysubmissions.rows , myacs:myacs.rows});
});

app.get("/new/glass-blowing-section",checkAuth,async(req,res)=>{

  const user = {
    ...req.user,
    emp_id: req.user.emp_id ?? req.user.empid ?? req.user.employee_id,
  };

  return res.render("new-gbs.ejs",{user});
})

app.post("/submit-gbs-application/:id",checkAuth,async(req,res)=>{
  const {description} = req.body;
  const arn = crypto.randomUUID();
  const section="GLASS BLOWING SECTION"

  const data = await client.query("insert into applications(arn, indentor, crew_serial_number,status, description,section) values($1,$2, $3, $4, $5,$6)",[arn,req.params.id,"N.A.","APPLICATION SUBMITTED",description,"GLASS BLOWING SECTION"]);

  if(data){
    return res.render("message.ejs",{message:"APPLICATION SUBMITTED SUCCESSFULLY !"})
  }
})

app.get("/store/dashboard/new-item",async(req,res)=>{

  return res.render("add-new-item.ejs");

})

app.get("/store/dashboard/new-inventory-record/bulk",async(req,res)=>{
  return res.render("message.ejs",{message:"COMING SOON !"})
})

app.get("/store/dashboard/new-inventory-record/:id",async(req,res)=>{


  const items = await client.query("select * from items where item_code = $1",[req.params.id]);

  return res.render("new-inventory-record.ejs",{items:items.rows[0]});

})


app.post("/store-login",async(req,res)=>{

const {store_email_id, password} = req.body;

const isAuthenticated = await StoreLogin(store_email_id,password, res);

  if (!isAuthenticated) {
    return res.status(401).send("Invalid Password");
  }

  return res.redirect("/store/dashboard");



})

app.get("/store/dashboard",async(req,res)=>{

  const items = await client.query("select * from items");

  const applications = await client.query("select * from applications where status=$1",["TECHNICIAN ASSIGNED"]);

  return res.render("store.ejs",{items:items.rows, applications:applications.rows});
})

app.get("/issue/:id",async(req,res)=>{
  const items = await client.query("select * from items");

  const applications = await client.query("select * from applications where arn=$1 and status=$2",[req.params.id,"TECHNICIAN ASSIGNED"]);

  return res.render("store-issue.ejs",{items:items.rows,applications:applications.rows[0]});

})

app.post("/issue-item/:id",async(req,res)=>{
  
  const {item} = req.body;

  const match = item.match(/\((.+)\)/);

  if (match) {
  console.log(match[1]); 
  }

  const data3= await client.query("select qty from items where item_code = $1",[match[1]]);

  const updated_qty = data3.rows[0].qty - match[1];

  const data4 = await client.query("update items set qty = $1 where item_code = $2",[updated_qty,match[1]]);

  const data = await client.query("update applications set material_issued = $1, status=$2 returning *",[item,"MATERIAL ISSUED BY STORE IN-CHARGE"]);

  if(data.rows[0]){
    return res.render("message.ejs",{message:"MATERIAL ISSUED !"})
  }
})

app.get("/new/:id", checkAuth, async (req, res) => {
  const data = await client.query(
    "select * from ac_database where crew_serial_number=$1",
    [req.params.id],
  );

  const availability_check = await client.query("select * from applications where crew_serial_number = $1 and status!=$2",[req.params.id,"COMPLETED"]);
  if(availability_check.rows[0]){
    return res.render("message.ejs",{message:"A Job Card Application for this Air Conditioner is already ACTIVE and has not been marked as COMPLETED. If you think this is an error, please reach out to us at onlinejobcard@iacs.res.in"});

  }

  const decodedUser = req.user

  if (data.rowCount === 0) {
    return res.status(404).render("new-ac.ejs", {
      result: null,
      error: "No AC record found for that crew serial number.",
    });
  }

  return res.render("new-ac.ejs", { result: data.rows[0], decodedUser });
});

app.post("/fetch-ac-details", async (req, res) => {
  const { crew_serial_number } = req.body;
  const data = await client.query(
    "select * from ac_database where crew_serial_number=$1",
    [crew_serial_number],
  );
  if (data.rowCount === 0) {
    return res
      .status(404)
      .send("No AC record found for that crew serial number.");
  }

  console.log(data.rows[0]);
  return res.render("new-ac.ejs", { result: data.rows[0] });
});

app.post("/submit-new-application", async (req, res) => {
  const { indentor, crew_serial_number, section, description} = req.body;

  const arn = crypto.randomUUID();

  

  const data = await client.query(
    "insert into applications (arn, indentor, crew_serial_number, status, description, section) values ($1, $2, $3, $4,$5,$6)",
    [arn, indentor, crew_serial_number, "APPLICATION SUBMITTED",description,"AIR CONDITIONING & REFRIGERATION SECTION"],
  );

  if (data) {
    return res.render("message.ejs",{message:"APPLICATION SUBMITTED !"});
  }
});


app.get("/login/technician", async(req,res)=>{

  return res.render("technician-login.ejs");
})

app.get("/technician/dashboard",checkTechAuth, async(req,res)=>{
  const technicianName = req.user?.technician_name;

  const applications = await client.query(
    "select * from applications where assigned_technician = $1 and (status=$2 or status=$3)",
    [technicianName,"TECHNICIAN ASSIGNED","MATERIAL ISSUED BY STORE IN-CHARGE"],
  );
  return res.render("technician.ejs",{applications: applications.rows});
})

app.post("/update/:id",async(req,res)=>{
  const {arn} = req.body;
  const data = await client.query("update applications set status=$1 where arn=$2","COMPLETED",arn)
})

app.post("/technician-login", async(req,res)=>{

const {technician_id, password } = req.body;

  const isAuthenticated = await TechnicianLogin(technician_id,password, res);

  if (!isAuthenticated) {
    return res.status(401).send("Invalid Password");
  }

  return res.redirect("/technician/dashboard");

});






app.post("/fetch-status", async (req, res) => {
  const { crew_serial_number } = req.body;
  const data = await client.query(
    "select * from applications where crew_serial_number=$1",
    [crew_serial_number],
  );
  if (data.rowCount === 0) {
    return res.render("status.ejs", { data: null });
  }

  return res.render("status.ejs", { data: data.rows[0] });
});

app.get("/admin", async (req, res) => {
  const data = await client.query("select * from applications");
  return res.render("admin.ejs", { data: data.rows });
});

app.get("/manage/:id", async (req, res) => {
  const data = await client.query(
    "select * from applications where arn = $1 and status = $2",
    [req.params.id,"APPLICATION SUBMITTED"],
  );

  if(!data.rows[0]){
    return res.render("message.ejs",{message:"ARN NOT ELIGIBLE !"})
  }
  const technician = await client.query("select * from technicians");
  return res.render("manage-applications.ejs", {
    result: data.rows[0],
    technician: technician.rows,
  });
});

app.post("/login", async (req, res) => {
  const { emp_id, password } = req.body;

  const isAuthenticated = await UserLogin(emp_id, password, res);

  if (!isAuthenticated) {
    return res.status(401).send("Invalid employee ID or password");
  }

  return res.redirect("/home");
});

app.get("/login", async (req, res) => {
  return res.render("login.ejs");
});

app.post("/assign-technician/:id", async (req, res) => {
  const { assigned_technician } = req.body;
  const arn = req.params.id;
  const data = client.query(
    "update applications set assigned_technician = $1 where arn = $2",
    [assigned_technician, arn],
  );

  if (data) {
    const data2 = client.query(
      "update applications set status = $1 where arn = $2",
      ["TECHNICIAN ASSIGNED", arn],
    );

    return res.render("message.ejs",{message:"TECHNICIAN ASSIGNED !"});
  }
});

app.get("/status", async (req, res) => {
  return res.render("status.ejs", { data: null });
});

app.listen(3000, async () => {
  console.log("Running on Port 3000!");
});