import express from 'express';
import bodyParser from 'body-parser';

const app = express();

app.get("/",async(req,res)=>{
    return res.render("home.ejs");
})

app.get("/new",async(req,res)=>{
    return res.render("new.ejs");
})

app.post("/fetch-ac-details",async(req,res)=>{
    const {crew_serial_number}= req.body;

})

app.get("/status",async(req,res)=>{
    return res.render("status.ejs");
})


app.listen(3000,async()=>{
    console.log("Running on Port 3000!");
})