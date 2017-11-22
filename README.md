# Github Social Graph
Github Social Graph is a script which let you to create a graph about the connected users on GitHub.  
It starts from one user and go as deep as you want.  
[DEMO](https://pyrooka.github.io/gsg/)

### Notes
- Without GitHub App registration the API call limit is 60/hour. With registration it's 5000.  
[https://github.com/settings/applications/new](https://github.com/settings/applications/new)
- In default the script skips the follower/following users if it's more than a value, to save API calls. You can change this in the config.
- The saved page may not working in Chrome because of the CORS. With Firefox it's working fine.

### Usage
1. ```npm install```
2. Check the ```config.js``` file.
3. ```gsgraph.js [-h] [-v] -u USER -d DEPTH [-r --refresh]```

### Sample video
[![Sample video](https://img.youtube.com/vi/dsKmlODHeXE/0.jpg)](https://youtu.be/dsKmlODHeXE)

### License
The MIT License (MIT)
