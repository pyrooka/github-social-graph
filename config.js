'use strict'

// Config which stores:
//   - the tokens for authenticating
//   - the limit for the requests (if an account has more then x,y followers or followings,
//     it will be rejected to save with the requests)
//     set to -1 for unlimited
// You can register your app at https://github.com/settings/applications/new.

const config = {
    clientId: process.env.GH_CLIENT_ID || '',
    clientSecret: process.env.GH_CLIENT_SECRET || '',
    followersLimit: 25,
    followingsLimit: 15,
}

module.exports = config