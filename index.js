const express = require('express');
const app = express();
const apn = require('apn');
const nodemailer = require('nodemailer');
var morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const chalk = require('chalk');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));


morgan.token('status', (req, res) => {
    const status = (typeof res.headersSent !== 'boolean' ? Boolean(res.header) : res.headersSent)
        ? res.statusCode
        : undefined;

    const color = status >= 500
        ? 'red'
        : status >= 400
            ? 'yellow'
            : status >= 300
                ? 'cyan'
                : status >= 200
                    ? 'green'
                    : 'gray';

    return chalk[color](status);
});

const format = `:method :url ${chalk.gray(':response-time ms')} :status`;
app.use(morgan(format));

const fs = require('fs');
const { PKPass } = require('passkit-generator');

let serverURL = 'https://8070-2001-569-729b-ee00-4937-d2ef-1877-a148.ngrok-free.app/';

const statusToPassModelMap = {
    assessed: 'assessed.pass',
    closed: 'closed.pass',
    settled: 'settled.pass',
    submitted: 'submitted.pass',
    validated: 'validated.pass'
};


const passModelPath = './passModels/';
const outputPath = './output/output.pkpass';
const certificatePath = './certificates/td-claim-cert-key.pem';
const keyPath = './certificates/tdi-claims-pk.pem';
const wwdrPath = './certificates/AppleWWDRCAG3.pem';
const keyPassphrase = 'Testing@123';

const emailFrom = 'deloittetd@gmail.com'; // i created a dummy gmail account
const emailPass = 'tpfl djiz pgyc zgrh'; // app password; app name: td

let SERIAL_NUMBER = '';
let LAST_UPDATED = '';
let STATUS = '';
// Array to hold the dates
let PAST_DATES = [];
let date_index = 0;


// APNs Configuration
const APP_BUNDLE_ID = "pass.ca.deloitte.tdiclaims";
const PRODUCTION_MODE = true;

// device tokens list
let DEVICE_TOKENS = [];

// notification payload
let notif_payload = {
    message: "Your notification!"
}

async function sendNotification(payload) {
    const options = {
        cert: fs.readFileSync(certificatePath),
        key: fs.readFileSync(certificatePath),
        production: PRODUCTION_MODE
    };

    const apnProvider = new apn.Provider(options);

    const notification = new apn.Notification();
    notification.topic = APP_BUNDLE_ID;
    notification.expiry = Math.floor(Date.now() / 1000) + 3600;
    notification.alert = payload.message;
    notification.payload = payload;

    console.log("sending notification to ", DEVICE_TOKENS, DEVICE_TOKENS[0])
    try {
        const result = await apnProvider.send(notification, DEVICE_TOKENS);

        // Check for failures
        if (result.failed && result.failed.length > 0) {
            throw new Error(result.failed[0].response.reason);
        }

        return result;
    } finally {
        apnProvider.shutdown();
    }
}

app.get('/send-notif', async (req, res) => {
    try {
        const response = await sendNotification(notif_payload);
        res.send({ message: "Notification sent successfully!", response });
    } catch (error) {
        console.error("Error sending notification:", error);
        res.status(500).send("Error sending notification: " + error.message);
    }

})
function fillDates() {
    // Get today's date
    const today = new Date();
    for (let i = 1; i <= 5; i++) {
        // Get the date i days before today
        let pastDate = new Date(today.getTime() - (i * 24 * 60 * 60 * 1000));
        PAST_DATES.push(pastDate.toISOString().replace('Z', '+00:00'));
    }

    date_index = PAST_DATES.length - 1;
}

function getEndOfMonthISOString() {
    // Get the current date
    let now = new Date();
  
    // Create a new date object for the end of the current month
    // Set the date to the first day of the next month, then subtract one day
    let endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  
    // Set the time to the last millisecond of the day
    endOfMonth.setHours(23, 59, 59, 999);
  
    // Convert to ISO string and replace 'Z' with the timezone offset '+00:00'
    return endOfMonth.toISOString().replace('Z', '+00:00');
}
  
function fileExists(_path) {
    return fs.existsSync(_path);
}

async function updatePassModel(model_path) {
    // 1. Read the pass.json file
    const passJsonPath = path.join(model_path, 'pass.json');
    console.log(passJsonPath);
    const passData = JSON.parse(fs.readFileSync(passJsonPath, 'utf8'));

    // 2. Modify the serialNumber and other properties
    if (model_path.includes('submitted') || SERIAL_NUMBER == '') {
        console.log('************NEW SERIAL NUMBER**********');
        SERIAL_NUMBER = uuidv4();
        console.log(chalk.blue.bgWhite(SERIAL_NUMBER));

        fillDates();
    }
    passData.serialNumber = SERIAL_NUMBER;
    LAST_UPDATED = Math.floor(Date.now() / 1000).toString();
    passData.webServiceURL = serverURL;
    passData.associatedStoreIdentifiers = [1435348849];
    passData.type = 'generic';
    //passData.logoText = 'TD';

    passData.eventTicket.secondaryFields[0].value = getEndOfMonthISOString();

    passData.eventTicket.secondaryFields[1] = {};
    passData.eventTicket.secondaryFields[1].key = 'last_updated';
    passData.eventTicket.secondaryFields[1].label = 'LAST UPDATED';
    passData.eventTicket.secondaryFields[1].value = PAST_DATES[date_index];

    date_index = date_index - 1;
    if (date_index < 0) {
        fillDates();
    }
    passData.eventTicket.secondaryFields[1].textAlignment = 'PKTextAlignmentRight';
    passData.eventTicket.secondaryFields[1].changeMessage = 'Your claim CL001921 was updated on %@. For more information check out the TD Insurance App.';
    passData.eventTicket.secondaryFields[1].dateStyle = 'PKDateStyleLong';

    passData.eventTicket.backFields = [
        {
            "key": "your_vehicle",
            "label": "Your Vehicle",
            "value": "Mercedes"
        },
        {
            "key": "license_plate",
            "label": "License Plate",
            "value": "BEEJ 681"
        }
    ];
    
    // 3. Write the updated data back to the pass.json file
    try {
        await fs.writeFileSync(passJsonPath, JSON.stringify(passData, null, 2));
    } catch (err) {
        console.error('Error writing to pass.json:', err);
    }
}

async function generateAndSavePass(status) {
    const model = statusToPassModelMap[status];

    if (!model) {
        throw new Error('Invalid status provided.');
    }
    const _passModelPath = passModelPath + model;
    if (!fs.existsSync(_passModelPath)) {
        throw new Error('pass model dir not found');
    }

    if (!fileExists(wwdrPath) || !fileExists(certificatePath) || !fileExists(keyPath)) {
        throw new Error("One or more required files do not exist.");
    }
    STATUS = status;
    console.log(chalk.magenta.bgYellow(STATUS));

        await updatePassModel(_passModelPath);

        const _pass = await PKPass.from({
            model: _passModelPath,
            certificates: {
                wwdr: fs.readFileSync(wwdrPath, 'utf8'),
                signerCert: fs.readFileSync(certificatePath),
                signerKey: fs.readFileSync(keyPath),
                signerKeyPassphrase: keyPassphrase
            },
        })

        const passBuffer = _pass.getAsBuffer();
        // Write the passBuffer to the outputPath
        try {
            fs.writeFileSync(outputPath, passBuffer);
        } catch (error) {
            console.error('Error writing to file:', error.message);
            throw error;
        }

}

// GET route for the pass.json which should link to this endpoint to receive updates?
// We might need to trigger the API call through Postman with query param that will move the pass into a different state?
app.get('/v1/passes/update/:status', async (req, res) => {

    const status = req.params.status;

    if (!status) {
        return res.status(400).send('Status parameter is required.');
    }

    try {
        await generateAndSavePass(status);
        await sendNotification({});
        res.send('Pass generated and saved successfully! Notification sent');
    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }
});

// client registers using this API
app.post('/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', (req, res) => {
    const deviceLibraryIdentifier = req.params.deviceLibraryIdentifier;
    const passTypeIdentifier = req.params.passTypeIdentifier;
    const serialNumber = req.params.serialNumber;
    if (SERIAL_NUMBER == '') {
        res.status(400).send("you need to send an email 1st!")
    }

    const pushToken = req.body.pushToken;

    console.log("deviceLibraryIdentifier", deviceLibraryIdentifier);
    console.log("passTypeIdentifier", passTypeIdentifier);
    console.log("serialNumber", serialNumber);
    console.log("pushToken", pushToken)

    if (DEVICE_TOKENS.length == 0) {
        DEVICE_TOKENS.push(pushToken);
        res.status(201).send({ status: 'success', message: 'Pass registered successfully' });
    } else {
        DEVICE_TOKENS[0] = pushToken;
        res.status(200).send({ status: 'success', message: 'Pass registered already' });
    }
});

//Get the List of Updatable Passes
app.get('/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/', (req, res) => {
    const deviceLibraryIdentifier = req.params.deviceLibraryIdentifier;
    const passTypeIdentifier = req.params.passTypeIdentifier;
    const passesUpdatedSince = req.query.passesUpdatedSince;

    console.log(deviceLibraryIdentifier, passTypeIdentifier, passesUpdatedSince);

    const objToSend = { "serialNumbers": [SERIAL_NUMBER], lastUpdated: LAST_UPDATED };
    console.log("SENDING", objToSend);
    res.status(200).send(objToSend);
});

app.post('/v1/serverurl', (req, res) => {
    try {
        let serverurl = req.body.url;
        if (!serverurl.includes('http')) {
            res.status(500).send('URL must have http or https');
        }
        if (serverurl[serverurl.length - 1] != '/') {
            serverurl = serverurl + '/';
        }
        serverURL = serverurl;
        res
            .status(200)
            .send({ status: 'success', message: 'server url is ' + serverURL });
    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }
});

// client requests updated pass
app.get('/v1/passes/:passTypeIdentifier/:serialNumber', (req, res) => {
    console.log("SENDING FILE: ", outputPath)
    if (fs.existsSync(outputPath)) {
        res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
        return res.status(200).sendFile(outputPath, { root: __dirname });
    } else {
        return res.status(404).send('Pass not found or invalid passKey.');
    }
});

async function sendEmailWithPass(emailTo) {
    await generateAndSavePass("submitted");
    // Create a SMTP transporter object
    let transporter = nodemailer.createTransport({
        service: 'gmail',  // you can use other services like 'yahoo', 'outlook' etc.
        auth: {
            user: emailFrom,
            pass: emailPass
        }
    });
    // Assuming you have an HTML file for the email template
    const emailTemplate = fs.readFileSync('./email-template/template.html', 'utf8');

    // Email options
    let mailOptions = {
        from: emailFrom,
        to: emailTo,
        subject: 'Your Apple Wallet Pass',
        text: 'Please find attached your Apple Wallet pass.',
        html: emailTemplate, // html body
        attachments: [
            {
                filename: SERIAL_NUMBER + '.pkpass',
                path: outputPath,  // Provide path to your .pkpass file
                contentType: 'application/vnd.apple.pkpass'
            }
        ]
    };

    // Send the email
    try {
        let info = await transporter.sendMail(mailOptions);
        console.log('Message sent:', info.response);
    } catch (error) {
        console.error('Error sending email:', error);
    }
}

app.get('/v1/sendEmail/:email', (req, res) => {
    try {
        email = req.params.email;
        sendEmailWithPass(email);
        res.status(200).send({ status: 'success', message: 'Email successfully' });

    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }

});

// Log a Message
app.post('/v1/log', (req, res) => {
    console.log("RECEIVED LOGS")
    console.log(req.body)

    res.status(200)
});

// Unregister a Pass for Update Notifications
app.delete('/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', (req, res) => {
    const deviceLibraryIdentifier = req.params.deviceLibraryIdentifier;
    const passTypeIdentifier = req.params.passTypeIdentifier;
    const serialNumber = req.params.serialNumber;

    console.log(deviceLibraryIdentifier, passTypeIdentifier, serialNumber);

    DEVICE_TOKENS = []
    res.status(200).send({ status: 'success', message: 'Pass deleted successfully' });
});

// Start the server
app.listen(3000, () => {
    console.log('Server started on port 3000');
});
