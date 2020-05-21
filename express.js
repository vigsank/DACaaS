require("dotenv").config();
const exec = require("child_process").exec;
const cors = require("cors");
const crypto = require("crypto");
const express = require("express");
const expressRequestId = require('express-request-id');
const expressPino = require('express-pino-logger');
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const fs = require("fs");
const https = require("https");
const path = require("path");
const pino = require('pino');

const app = express();
const PARENT_FOLDER_FOR_LOCAL_REPO = process.env.BUILD_DIRECTORY_PATH || "Builds";
// These are really not errors but unsure why child process is considering these as errors. So ignoring those which are ideally not.
const IGNORABLE_ERRORS = [
  "Java HotSpot(TM) 64-Bit Server VM warning", 
  "Cloning into", 
  `Already on`, 
  "Total", 
  "Switched to a new branch",
];

//  apply rate limit to all requests
const limiter = rateLimit({
  windowMs: (process.env.TIME_INTERVAL || 30) * 60 * 1000, // 30 minutes
  max: process.env.MAX_NO_OF_REQUESTS || 10 // limit each IP to 5 requests per windowMs
});
app.use(limiter);

// CORS check
const corsOptions = {
  origin: process.env.HOST,
};
app.use(cors(corsOptions));

// Access to static files
app.use(express.static(path.join(__dirname, "public")));

// Add logger framework
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const expressLogger = expressPino({ logger });
app.use(expressLogger);

// initialize session
app.use(
  session({
    //secret to sign the session ID cookie
    secret: process.env.SESSION_SECRET,
    resave: true,
    saveUninitialized: true,
  })
);

// add Request ID
app.use(expressRequestId());

getIsIgnorableError = (errMsg) => {
  // check if the error msg is part of ignorable list.
  return IGNORABLE_ERRORS.some((ignorableErr) => errMsg.indexOf(ignorableErr) > -1);
}

getPrepareLocalRepoCommands = (tempDirName, branchName, req) => {
  const cloneCommand = process.env.REPO_CLONE_COMMAND;
  addLog(req, "info", `Temp Directory named ${tempDirName} will be created under ${PARENT_FOLDER_FOR_LOCAL_REPO}.`);
  let prepareLocalRepoCommands = `cd ${PARENT_FOLDER_FOR_LOCAL_REPO} && mkdir ${tempDirName} && cd ${tempDirName} && `;
  prepareLocalRepoCommands += `${!cloneCommand.startsWith("git clone ") ? `git clone ${cloneCommand}` : cloneCommand}`;
  prepareLocalRepoCommands += ` && cd ${getRepoName()} && git checkout ${branchName} && git reset --hard origin/${branchName} && git pull`;
  return prepareLocalRepoCommands;
}

getRepoName = () => {
  return process.env.REPO_NAME;
}

getPathToLocalRepo = (tempDirName) => {
  return path.join(PARENT_FOLDER_FOR_LOCAL_REPO, tempDirName, getRepoName());
}

getBuildCommands = (tempDirName) => {
  return `cd ${getPathToLocalRepo(tempDirName)} ${process.env.LOAD_MAVEN ? `&& ${process.env.LOAD_MAVEN}` : ``
    } && ${process.env.BUILD_COMMANDS}`;
}

getDockerCommands = (tempDirName, req) => {
  const dockerImageName = `${process.env.DOCKER_IMAGE_NAME}${tempDirName}`;
  req.session["dockerImageName"] = dockerImageName;
  return `cd ${getPathToLocalRepo(
    tempDirName
  )} && docker build -t ${dockerImageName} -f ${
    process.env.DOCKER_FILE_PATH ? process.env.DOCKER_FILE_PATH : "./DockerFile"
  } ${
    process.env.ACTUAL_PATH_TO_DOCKERIZE
      ? `${process.env.ACTUAL_PATH_TO_DOCKERIZE}`
      : `./`
  } && docker save -o ./${dockerImageName}.tar ${dockerImageName} ${
    process.env.DELETE_DOCKER_IMAGE_POST_COMPLETE === "false"
      ? ``
      : `&& docker image rm ${dockerImageName}`
  }`;
}

getRandomNumber = (req) => {
  const randomNumber = crypto.randomBytes(4).toString("hex");
  addLog(req, "info",`Generated Random Number is : ${randomNumber}.`);
  return randomNumber;
}

downloadArchive = (req, res, tempDirNameFromSession) => {
  const tempDirName = tempDirNameFromSession ? req.session["tempDirName"] : req.params.tempDirectoryName;
  const pathToLocalRepo = getPathToLocalRepo(tempDirName || "");
  const fileToDownload = path.resolve(pathToLocalRepo, req.session["dockerImageName"] || "") + ".tar";
  addLog(req, "debug", `Path to download file : ${fileToDownload}`);
  if (fs.existsSync(fileToDownload)) {
    addLog(req, "info", "File exists. Downloading it.");
    res.download(fileToDownload);
  }
  else {
    addLog(req, "error", "Either the file is unavailable to download or the request to download is invalid");
    res.status(200).set({
      "content-type": "application/json",
    }).send({
      status: "error",
      reason: "Either the file is unavailable to download or the request to download is invalid"
    });
  }
}

writeResponse = (req, res, type, resToBeWritten, logMsg) => {
  addLog(req, "info", logMsg);
  if (res && type && resToBeWritten) {
    const data = {
      type: type,
      result: resToBeWritten
    };
    res.write("data:" + `${JSON.stringify(data)}\n\n`);
  }
}

addLog = (req, type, logMsg) => {
  switch (type) {
      case "info":
        logger.info(`[${req.session["requestId"]}] ${logMsg}`);
        break;
      case "debug":
        logger.debug(`[${req.session["requestId"]}] ${logMsg}`);
        break;
      case "error":
        logger.error(`[${req.session["requestId"]}] ${logMsg}`);
        break;
      default:
        logger.info(`[${req.session["requestId"]}] ${logMsg}`);
        break;
  }
}

execChildProcess = (command, isLastCommand, req, res) => {
  let closedDueToError = false;
  let errorMsg = "";
  return new Promise((resolve, reject) => {
    addLog(req, "debug", `The command to be executed is "${command}"`);
    var child = exec(command);
    child.stdout.setEncoding("utf8");

    /**
     * On Receiving Valid Data
     */
    child.stdout.on("data", (chunk) => {
      chunk = { type: "data", result: chunk };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    });

    /**
     * On Receiving Error Data
     */
    child.stderr.on("data", (err) => {
      addLog(req, "info", `Child process throw an error : ${err}. Checking if it can be ignored and proceeded.`);
      const isIgnorableError = getIsIgnorableError(err);
      isIgnorableError ? addLog(req, "info", "Ignorable. Proceeding further with the process.") : addLog(req, "error", "Not Ignorable!! Check if it can be added to ignorable list or a genuine error.");
      if (!isIgnorableError) {
        closedDueToError = true;
        const data = {
          type: "error",
          result: err
        };
        res.write("data:" + `${JSON.stringify(data)}\n\n`);
      }
    });

    /**
     * On Closing the process
     */
    child.on("close", (close) => {
      if (isLastCommand && !closedDueToError) {
        addLog(req, "info","Last Command done.!!");
        close = { type: "close", result: "SuccessFully Created a Docker archive !! " };
        res.write("data:" + `${JSON.stringify(close)}\n\n`);
        res.end();
      } else if (closedDueToError) {
        addLog(req, "error", `Ending Response due to the error!!`);
        // response written by stderr block. Just closing the response.
        res.end();
        // to close the lifecycle of promise
        reject(errorMsg);
      }
      resolve("Success");
    });
  });
}

app.get("/", (req, res) => {
  res.status(200).set({
    "content-type": "application/json",
  }).send({
    status: "running",
    pathToStartABuild: `/branch/<branchName>`,
    configuredFor: process.env.REPO_NAME
  });
});

app.get("/branch/:branchName", async (req, res) => {
  const branchName = req.params.branchName;
  req.session["branchName"] = branchName;
  req.session["requestId"] = req.id;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.write(fs.readFileSync("./index.html"));
  res.end();
});

app.get("/start-build", async (req, res) => {
  const branchName = req.session["branchName"];
  addLog(req, "info", `Branch to be processed : ${branchName}`)
  res.status(200).set({
    connection: "keep-alive",
    "cache-control": "no-cache",
    "content-type": "text/event-stream",
  });

  const tempDirName = getRandomNumber(req);
  req.session["tempDirName"] = tempDirName;

  let prepareLocalRepoProcess = undefined;
  let buildCommandsProcess = undefined;
  let dockerCommandsProcess = undefined;

  if (!branchName) {
    writeResponse(req, res, "error", "\n\n**********Branch Name Not Specified!! Will not Start the process.***********\n\n", "No Branch Name!!");
    res.end(); execChildProcess
  } else {
    writeResponse(req, res, "eocLine", "\n\n**********Preparing the local repo!!***********\n\n", "Starting the process!!");
    prepareLocalRepoProcess = await execChildProcess(getPrepareLocalRepoCommands(tempDirName, branchName, req), false, req, res).catch((err) => { addLog(req, "error, "`Unexpected Error : ${err}`); })
    if (prepareLocalRepoProcess === "Success") {
      writeResponse(req, res, "eocLine", "\n\n**********End of Preparing the local repo. Starting Build Commands!!***********\n\n", "Cloned and prepared the local repo!!");
      buildCommandsProcess = await execChildProcess(getBuildCommands(tempDirName), false, req, res).catch((err) => { addLog(req, "error", `Unexpected Error : ${err}`); });
      if (buildCommandsProcess === "Success") {
        writeResponse(req, res, "eocLine", "\n\n**********End of Build Commands. Starting Docker Commands!!***********\n\n", "Ran Build commands!!");
        dockerCommandsProcess = await execChildProcess(getDockerCommands(tempDirName, req), true, req, res).catch((err) => { addLog(req, "error", `Unexpected Error : ${err}`); });
      }
      if (dockerCommandsProcess === "Success") {
        writeResponse(req, undefined, undefined, undefined, "Ran Docker commands!! This finishes the entire process!!");
      }
    }
  }

});

app.get("/test/branch/:branchname", (req, res) => {
  const branchName = req.params.branchname;
  res.status(200).set({
    connection: "keep-alive",
    "cache-control": "no-cache",
    //"content-type": "application/json",
    "content-type": "text/event-stream",
  });
  let counter = 0;
  //res.write("event: message\n");
  res.write("data:" + `${counter} : ` + `${branchName}\n\n\n`);
  setInterval(() => {
    counter++;
    if (counter <= 3) {
      res.write("data:" + `${counter} : ` + `${branchName}\n\n\n`);
    } else {
      res.end();
    }
  }, 2000);
});

app.get("/download/:tempDirectoryName", (req, res) => {
  downloadArchive(req, res, false);
});

app.get("/download", (req, res) => {
  downloadArchive(req, res, true);
});

https.createServer(
  {
    pfx: fs.readFileSync(process.env.SERVER_CERT_PATH),
    passphrase: process.env.PASSPHRASE,
  },
  app
)
  .listen(process.env.HTTPS_PORT, () => logger.info(
    `Secure Service started at: https://${process.env.HOST}:${process.env.HTTPS_PORT}`
  ));

if (process.env.HTTP_PORT) {
  app.listen(process.env.HTTP_PORT, () => {
    logger.info(
      `Insecure Service started at: http://${process.env.HOST}:${process.env.HTTP_PORT}`
    );
  });
}

