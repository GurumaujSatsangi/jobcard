import express from 'express';
import bodyParser from 'body-parser';
import {Session} from 'express-session'
import { Client } from 'pg'
import ejs from 'ejs';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import jsonwebtoken from 'jsonwebtoken';
import bcrypt from 'bcrypt';


dotenv.config();


const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));

const transporter = nodemailer.createTransport({
  host: "smtp.example.com",
  port: 587,
  secure: false, // use STARTTLS (upgrade connection to TLS after connecting)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});




const dbHost = process.env.DB_HOST === 'postgres' ? 'localhost' : process.env.DB_HOST;
const dbPort = Number(process.env.DB_PORT || 5432);

const client = new Client({
user: process.env.DB_USER,
password: process.env.DB_PASSWORD,
host: dbHost,
port: dbPort,
database: process.env.DB_NAME,
});

await client.connect();
async function UserLogin(employee_id, password) {
    const user = await client.query(
        "select hashed_password from users where employee_id = $1",
        [employee_id]
    );

    if (user.rowCount === 0) {
        return false;
    }

    const isValidPassword = await bcrypt.compare(
        password,
        user.rows[0].hashed_password
    );

    return isValidPassword;
}


app.get("/",async(req,res)=>{
    return res.render("login.ejs");
})

app.get("/new",async(req,res)=>{
    return res.render("new.ejs");
})

app.get("/new/:id",async(req,res)=>{
    const data = await client.query("select * from ac_database where crew_serial_number=$1",[req.params.id]);

    res.render("new-application.ejs",{result: data.rows[0]});
})

app.post("/fetch-ac-details",async(req,res)=>{
    const {crew_serial_number}= req.body;
    const data = await client.query("select * from ac_database where crew_serial_number=$1",[crew_serial_number]);
    if (data.rowCount === 0) {
        return res.status(404).send("No AC record found for that crew serial number.");
    }

    console.log(data.rows[0]);
    return res.render("new-application.ejs",{result:data.rows[0]});

})

app.post("/submit-new-application",async(req,res)=>{
    const {indentor, crew_serial_number} = req.body;
    const data = await client.query("insert into applications (indentor, crew_serial_number, status) values($1,$2,$3)",[indentor,crew_serial_number,"APPLICATION SUBMITTED"]);

    if(data){
        return res.send("Submitted Succesfully !");
    }
})

app.post("/fetch-status",async(req,res)=>{
    const {crew_serial_number} = req.body;
    const data = await client.query("select * from applications where crew_serial_number=$1",[crew_serial_number]);
    if (data.rowCount === 0) {
        return res.render("status.ejs",{data:null});
    }

    return res.render("status.ejs",{data:data.rows[0] });
})

app.get("/admin",async(req,res)=>{
    const data = await client.query("select * from applications");
    return res.render("admin.ejs",{data:data.rows});
})

app.get("/manage/:id",async(req,res)=>{
    const data = await client.query("select * from applications where crew_serial_number = $1",[req.params.id]);
    const technician = await client.query("select * from technicians");
    res.render("manage-applications.ejs",{result: data.rows[0], technician: technician.rows});

})

app.post("/login",async(req,res)=>{

    const {emp_id,password} = req.body;

    const isAuthenticated = await UserLogin(emp_id, password);

    if (!isAuthenticated) {
        return res.status(401).send("Invalid employee ID or password");
    }

    return res.redirect("/new");


})

app.get("/login",async(req,res)=>{

    

    return res.render("login.ejs");
})

app.post("/assign-technician",async(req,res)=>{
    const {assigned_technician, crew_serial_number} = req.body;
    const data = client.query("update applications set assigned_technician = $1 where crew_serial_number = $2",[assigned_technician,crew_serial_number]);

    if(data){
        const data2 = client.query("update applications set status = $1 where crew_serial_number = $2",["TECHNICIAN ASSIGNED",crew_serial_number]);

        res.send("Assigned Successfully !");
    }
})

app.get("/status",async(req,res)=>{
    return res.render("status.ejs",{data:null});
})

app.listen(3000,async()=>{
    console.log("Running on Port 3000!");
})