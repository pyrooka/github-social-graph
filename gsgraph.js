'use strict'

/*
* TODO:
*      - better error handling. I was too lazy.
*      - better caching?
*      - save output html with the data
*/

const fs = require('fs')
const path = require('path')

const _ = require('lodash')
const chalk = require('chalk')
const express = require('express')
const request = require('request-promise-native')
const ArgumentParser = require('argparse').ArgumentParser

const config = require('./config')


const USERS_API_URL = 'https://api.github.com/users/'
const LIMIT_API_URL = 'https://api.github.com/rate_limit'
const USER_AGENT = 'github-social-graph'
const PORT = 3003
const TOKEN = config.clientId && config.clientSecret ?
              `?client_id=${config.clientId}&client_secret=${config.clientSecret}` : ''
const CACHE_FILE_NAME = '.users_cache'

// Style for the Cytoscape lib.
const style = [
  {
    selector: 'node',
    style: {
      'label': 'data(username)',
      'text-valign': 'top',
      'text-halign': 'center',
      'background-color': '#555',
      'text-outline-color': '#555',
      'text-outline-width': '2px',
      'color': '#fff',
      'background-fit': 'cover',
    }
  },
  {
    selector: 'edge',
    style: {
      'width': 3,
      'line-color': '#ccc',
      'curve-style': 'bezier',
      'target-arrow-shape': 'triangle',
    }
  },
]

// Cache.
let cache = []


// Prepare the data for the cytoscape graph.
function prepareData(users) {
  let data = []
  let edges = []

  console.log(chalk.green('Preparing data...'))

  // Push the nodes (users) to the array.
  // First the target user.
  data.push({ data: users[0] })
  style.push({ selector: '#' + users[0].id, style: { 'background-image': users[0].avatar, 'text-outline-color': '#f00' }})
  // Than the others.
  for (let i = 1; i < users.length; ++i) {
    data.push({ data: users[i] })
    style.push({ selector: '#' + users[i].id, style: { 'background-image': users[i].avatar }})
  }

  // Now create the edges.
  for (let user of users) {
    if (user.followers) {
      for (let follower of user.followers) {
        // Get the follower user object.
        const followerObj = _.find(users, { 'username': follower })
        if (!followerObj) {
          continue
        }

        const edgeObj = { source: followerObj.id, target: user.id }

        if (_.findIndex(edges, edgeObj) != -1) {
          continue
        }

        edges.push(edgeObj)
      }
    }
    if (user.followings) {
      for (let following of user.followings) {
        // Get the following user object.
        const followingObj = _.find(users, { 'username': following })
        if (!followingObj) {
          continue
        }

        const edgeObj = { source: user.id, target: followingObj.id }

        if (_.findIndex(edges, edgeObj) != -1) {
          continue
        }

        edges.push(edgeObj)
      }
    }
  }

  for (let i = 0; i < edges.length; ++i) {
    data.push({ data: { id: 'edge' + i, source: edges[i].source, target: edges[i].target }})
  }

  return data
}

// Get all the user.
async function getAllUser(username, depth, refresh) {
  try{
    // All of the users in the session.
    let users = []
    // All of the users in the current iteration.
    let usersToGet = []
    // Store the user download data promises.
    let promises = []

    // First get our main user.
    const mainUser = await getUserData(username, refresh)
    // Get the users to get in the next round.
    usersToGet = mainUser.followers ?  usersToGet.concat(mainUser.followers) : usersToGet
    usersToGet = mainUser.followings ? usersToGet.concat(mainUser.followings) : usersToGet
    // Make the array uniq.
    usersToGet = _.uniq(usersToGet)

    // Now go deeper.
    for (let i = 0; i < depth; ++i) {
      console.log(chalk.cyan('Current depht:'), i + 1)

      // Iterate over the users.
      for (let user of usersToGet) {
        // If we already have this user in the array,
        if (_.findIndex(users, { 'username': user }) != -1) {
          // skip.
          continue
        }

        console.log(chalk.cyan('User to get:'), user)
        // Else push it to the promises array.
        promises.push(getUserData(user))
      }

      console.log(chalk.green(`Downloading ${promises.length} user(s)...`))
      // Start all the promises.
      const result = await Promise.all(promises)

      // Reset the arrays for the next iteration.
      promises = []
      usersToGet = []

      // Add the result to the user array.
      users = users.concat(result)

      // Fill the array for the next round with new users.
      for (let user of result) {
        usersToGet = user.followers ?  usersToGet.concat(user.followers) : usersToGet
        usersToGet = user.followings ? usersToGet.concat(user.followings) : usersToGet
      }

      // Make it uniq. We don't want to get a user more than one time!
      usersToGet = _.uniq(usersToGet)
    }

    // Before we return push the main user to the beginning of the array.
    users.unshift(mainUser)

    return users
  } catch (err) {
    throw err
  }
}

// Create the parser than return the parsed arguments.
function getArgs() {

  let parser = new ArgumentParser({
    version: '0.1',
    addHelp: true,
    description: 'Create a graph with the social connections on GitHub.'
  })

  parser.addArgument(
    ['-u', '--user'],
    {
      type: 'string',
      required: true,
      help: 'GitHub username to start.'
    }
  )
  parser.addArgument(
    ['-d', '--depth'],
    {
      type: 'int',
      required: true,
      help: 'The depth of the graph starting from the user.'
    }
  )
  parser.addArgument(
    ['-r --refresh'],
    {
      action: 'storeTrue',
      help: 'Refresh/update the cached users. If used every data will be requested from the API.'
    }
  )

  return parser.parseArgs()
}

// Load the JSON cache. It's a synchronous function.
function loadCache() {
  // Read it sync because we have to wait it at the start so it doesn't matter.
  // If the file doesn't exists, create a new one and return false.
  if (!fs.existsSync(CACHE_FILE_NAME)) {
    fs.writeFileSync(CACHE_FILE_NAME, JSON.stringify({ users: [] }))

    return false
  }

  const cacheJson = fs.readFileSync(CACHE_FILE_NAME)

  try {
    cache = JSON.parse(cacheJson).users
  } catch (err) {
    console.log(chalk.red(err))
    return false
  }

  return true
}

// Update the cache.
function updateCache(users, refresh, callback) {
  // Iterates over all the users.
  for (const user of users) {
    // Check if the user is already in the cache.
    const userIndex = _.findIndex(cache, { 'id:': user.id })

    // If not,
    if (userIndex === -1) {
      // simply add it.
      cache.push(user)
      continue
    }
    // If it's in the cache already and have to refresh it.
    // If we use the refresh it means the user data is from the API in this session so it's newer than the old one.
    if (refresh) {
      cache[userIndex] = user
    }
  }

  // Write the cache to file.
  fs.writeFile(CACHE_FILE_NAME, JSON.stringify({ users: cache }), callback)
}

// Get user informations from the GitHub API or the local cache.
async function getUserData(username, refresh) {
  let user

  try {
    // If no need to refresh the user and we can use the cache
    if (!refresh && cache.length) {
      // search for the user.
      const userObj = _.find(cache, { 'username': username })
      // If we found the user in the cache
      if (userObj) {
        console.log(chalk.green('Using cached data for ') + username)
        // return it immediately.
        return userObj
      }
    }

    // Make the request.
    const body = await request({ url: USERS_API_URL + username + TOKEN, headers: { 'User-Agent': USER_AGENT }})

    const parsedBody = JSON.parse(body)

    const user = {
      id: parsedBody.id,
      username: parsedBody.login,
      name: parsedBody.name,
      company: parsedBody.company,
      location: parsedBody.location,
      blog: parsedBody.blog,
      email: parsedBody.email,
      public_repos: parsedBody.public_repos,
      public_gists: parsedBody.public_gists,
      avatar: parsedBody.avatar_url,
      followers_count: parsedBody.followers,
      following_count: parsedBody.following,
      lastUpdated: new Date().toISOString(),
    }

    // Get the follower users, if it's any and less than the limit.
    if (user.followers_count) {
      if (config.followersLimit < 0 || user.followers_count < config.followersLimit) {
        user.followers = await getFollowerUsers(username)
      } else {
        console.log(chalk.green('User ') + user.username + chalk.green(' followers has been skipped. ') + user.followers_count)
      }
    }

    // Get the following users, if it's any and less than the limit.
    if (user.following_count) {
      if (config.followingsLimit < 0 || user.following_count < config.followingsLimit) {
        user.followings = await getFollowingUsers(username)
      } else {
        console.log(chalk.green('User ') + user.username + chalk.green(' following users has been skipped. ') + user.following_count)
      }
    }

    // We don't need the numbers any more.
    delete user.followers_count
    delete user.following_count

    return user
  } catch (err) {
    throw err
  }
}

// Get the following users.
function getFollowingUsers(username) {
  return new Promise((resolve, reject) => {
    request({
      url: USERS_API_URL + username + '/following' + TOKEN,
      headers: {
        'User-Agent': USER_AGENT
      }
    }, (err, res, body) => {
      if (err) {
        // Log the error here, becuse we dont check error when call this function.
        console.log(chalk.red('[getFollowingUsers] Error:', err))
        reject(err)
        return
      }

      if (res.statusCode !== 200) {
        reject(new Error('Bad status code: ' + res.statusCode ))
        return
      }

      // Parse the given body.
      try {
        const parsedBody = JSON.parse(body)

        let users = parsedBody.map(user => {
          return user.login
        })

        resolve(users)
      } catch (err) {
        reject(err)
      }
    })
  })
}

// Get the followers.
function getFollowerUsers(username) {
  return new Promise((resolve, reject) => {
    request({
      url: USERS_API_URL + username + '/followers' + TOKEN,
      headers: {
        'User-Agent': USER_AGENT
      }
    }, (err, res, body) => {
      if (err) {
        console.log(chalk.red('[getFollowerUsers] Error:', err))
        reject(err)
        return
      }

      if (res.statusCode !== 200) {
        reject(new Error('Bad status code: ' + res.statusCode ))
        return
      }

      // Parse the given body.
      try {
        const parsedBody = JSON.parse(body)

        let users = parsedBody.map(user => {
          return user.login
        })

        resolve(users)
      } catch (err) {
        reject(err)
      }
    })
  })
}

// Get the remaining limit.
async function getLimit() {
  try {
    const body = JSON.parse(await request({ url: LIMIT_API_URL + TOKEN, headers: { 'User-Agent': USER_AGENT }}))
    return { max: body.resources.core.limit, left: body.resources.core.remaining }
  } catch (err) {
    throw err
  }
}

// Main function.
function main() {
  // Init check.
  if (!config.clientId || !config.clientSecret) {
    console.log(chalk.red('Not all the tokens provided. The app may won\'t work well.'))
  }

  // Get the argumenst from the command line.
  const args = getArgs()

  // Use the cache if at least one user in it.
  const isCacheLoaded = loadCache()

  let data = null

  // Create the express app.
  const server = express()
  // With ejs template engine.
  server.set('view engine', 'ejs')
  // Views in the root dir. Sorry too small project for structuring better.
  server.set('views', path.join(__dirname))
  // Bind libs path.
  server.use('/jquery', express.static(path.join(__dirname, 'node_modules', 'jquery', 'dist')))
  server.use('/qtip2', express.static(path.join(__dirname, 'node_modules', 'qtip2', 'dist')))
  server.use('/cytoscape', express.static(path.join(__dirname, 'node_modules', 'cytoscape', 'dist')))
  server.use('/cytoscape-qtip', express.static(path.join(__dirname, 'node_modules', 'cytoscape-qtip')))

  // Base route.
  server.get('/', (req, res) => {
    res.render('template', {
      data: data,
      style: style,
    })
  })

  getAllUser(args.user, args.depth, args.refresh)
    .then(async users => {
      // Update the cache in the background.
      console.log(chalk.green('Updating cache in the background. Please do not exit!'))
      updateCache(users, args.refresh, err => {
        if (err) console.log(chalk.red('Error during the cache update.', err))
        else console.log(chalk.green('Cache successfully updated.'))
      })

      data = users ? prepareData(users) : [{ data: { id: 'ERR', username: 'No user :(' }}]

      // Start listening.
      server.listen(PORT)
      console.log(chalk.green('Server listening on port:'), PORT)

      const limitObj = await getLimit()
      console.log(`${limitObj.left} of ${limitObj.max} API call remaining.`)
      })
      .catch(err => {
        console.log(chalk.red('Error occured! The server didn\'t start.'))
        console.log(err)
  })
}

// Start!
main()