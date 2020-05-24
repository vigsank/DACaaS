# Docker Archive Creation as a Service (DACaaS)
Create Docker Image for **any** project (built using **any** language/framework) based on given Branch Name.
(Ex: http://localhost:1234/branch/master --  Here `master` is the branch name.)

This is a highly secure and fully customizable simple Express server that can receive a branch name as a URL Param (stops if ran without a branchName.) and then start the commands that are configured to create a docker image and in turn create a **Tar** archive.
At the end, the archive file will be available for download.

The status of the commands that are being executed will be shown in the browser window (like a console.) via *event-stream*.

## Sequence of Execution:
  - Creates a Folder and clones a fresh copy of the project into it.
  - Checks out to the branch specified and pull latest code from that branch.
  - Runs all the configured Build Commands.
  - Runs all the configured Docker commands to finally create a Docker Archive.
  - If Enabled, Removes the Docker image created.
  - Enables Download option to download the archive.

Starting this Service would need a Environment File (.env) with following details.

```
# FQDN where this server is hosted
HOST=

# Secure Port to start this Server
HTTPS_PORT=

# Insecure Port to start this Server. Ignore if no insecure server instance is needed.
HTTP_PORT=

# Folder Directory where the Temp folder should be created (Starting from cloning till archive creation, everything will happen here).
# Defaults to "Builds" folder at Root of this project.
BUILD_DIRECTORY_PATH=

# Repo Clone command (if prefix 'git clone' isn't available, it will be auto prefixed)
REPO_CLONE_COMMAND=

# Repo Name (should be same as folder name that appears when cloning the project)
REPO_NAME=

# Project could be built with any language. So build commands might vary.
# Can have multiple build commands concatenated by && . (Ex: command1 && command2)
BUILD_COMMANDS=

# This name will be appended with a Random number to make it unique in docker image list
DOCKER_IMAGE_NAME=

# To delete the Docker Image post archive creation. Recommended to be true else Docker memory would fill up leading to unresponsive Daemon.  Defaults to true.
DELETE_DOCKER_IMAGE_POST_COMPLETE=


##########################################################
# Below variables are needed only when actual code to be dockerized and archived is not at root level of the project but at child level.

# Path relative to root that should be dockerized and archived
ACTUAL_PATH_TO_DOCKERIZE=

# Path relative to root that has DockerFile
DOCKER_FILE_PATH=
##########################################################


##########################################################
# Below variables are needed only for Maven based projects.

# In my Mac, I had to source bash_profile (source ~/.bash_profile) once to run mvn command through this project. So below variable would be helpful to set the command needed to export mvn. Ignore if its exported and available by default.
LOAD_MAVEN=
##########################################################


##########################################################
# Below are some config variables to enable request rate-limits (using express-rate-limit package)

# Time interval for rate-limit ('windowMs' as per express-rate-limit). Defaults to 30 mins.
TIME_INTERVAL=

# Max no of intervals that the server can accept from one IP within the above set TIME_INTERVAL ('max' as per express-rate-limit). Defaults to 5 requests. 
MAX_NO_OF_REQUESTS=
##########################################################


##########################################################
# Below variables are used to configure Security aspects.

# Secret used to sign the Session Cookie. High Randomness ensures Better Encryption
SESSION_SECRET=

# HTTPS certificate path (Requires a p12 cert)
SERVER_CERT_PATH=

# Passphrase for SSL certificate
PASSPHRASE=
##########################################################

```

## Logging Framework Used : [Pino](https://getpino.io/#/).
  - Set LOG_LEVEL env variable with supported values as per Pino docs to see different log levels.
  - Currently 'info' , 'debug' and 'error' are the levels used in implementation.

## Frameworks Used for enhanced security :
  - [helmet](https://helmetjs.github.io/)
  - [csurf](https://github.com/expressjs/csurf)
  - [cors](https://github.com/expressjs/cors#readme)
  - [express-rate-limit](https://github.com/nfriedly/express-rate-limit)
