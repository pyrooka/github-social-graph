'use strict'

/*
* TODO:
*      - better error handling. I was too lazy.
*      - better caching?
*/

const fs = require('fs')
const path = require('path')

const ejs = require('ejs')
const _ = require('lodash')
const chalk = require('chalk')
const express = require('express')
const requestLegacy = require('request')
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
const IMAGES_DIR_NAME = '.images'

const IMAGE_EXTENSIONS = ['JPG', 'JPEG', 'PNG']

// Style for the Cytoscape lib.
const style = [
  {
    selector: 'node',
    style: {
      'label': 'data(username)',
      'text-valign': 'top',
      'text-halign': 'center',
      'background-color': '#323232',
      'text-outline-color': '#323232',
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

// Cache with the user objects and the name of the cached images.
let cache = {
  users: [],
  images: [],
}

// Should we refresh the cache?
let refresh = false


// Prepare the data for the cytoscape graph.
function prepareData(users) {
  let data = []
  let edges = []

  console.log(chalk.green('Preparing data...'))

  // Push the nodes (users) to the array.
  for (let i = 0; i < users.length; ++i) {

    // Check if we have cached image or not.
    for (const image of cache.images) {
      if (image[0] === users[i].id.toString()) {
        users[i].avatar = `images/${users[i].id}.${image[1]}`
      }
    }

    data.push({ data: users[i] })

    if (i === 0) {
      style.push({ selector: '#' + users[0].id, style: { 'background-image': users[0].avatar, 'text-outline-color': '#f00' }})
    }
    else if (users[i].followers && users[i].followers === -1 || users[i].followings && users[i].followings === -1) {
      style.push({ selector: '#' + users[i].id, style: { 'background-image': users[i].avatar, 'text-outline-color': '#32328c' }})
    } else {
      style.push({ selector: '#' + users[i].id, style: { 'background-image': users[i].avatar }})
    }
  }

  // Now create the edges.
  for (let user of users) {
    if (user.followers && user.followers !== -1) {
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
    if (user.followings && user.followings !== -1) {
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
async function getAllUser(username, depth) {
  try{
    // All of the users in the session.
    let users = []
    // All of the users in the current iteration.
    let usersToGet = []
    // Store the user download data promises.
    let promises = []

    // First get our main user.
    const mainUser = await getUserData(username)
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
        usersToGet = user.followers && user.followers !== -1 ?  usersToGet.concat(user.followers) : usersToGet
        usersToGet = user.followings && user.followings !== -1 ? usersToGet.concat(user.followings) : usersToGet
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
    ['-r', '--refresh'],
    {
      action: 'storeTrue',
      help: 'Refresh/update the cached users. If used every data will be requested from the API.'
    }
  )
  parser.addArgument(
    ['-s', '--save'],
    {
      action: 'storeTrue',
      help: 'Save the generated page.'
    }
  )

  return parser.parseArgs()
}

// Load the JSON cache and the list of the images' name. It's a synchronous function.
function loadCache() {
  // Use sync because we have to wait it at the start so it doesn't matter.
  // Start with the images, becuse it's less important than the users.
  // If the directory isn't exists create it.
  if (!fs.existsSync(IMAGES_DIR_NAME)) {
    fs.mkdirSync(IMAGES_DIR_NAME)
  } else {
    // List the files.
    const files = fs.readdirSync(IMAGES_DIR_NAME)
    // If the file has the correct extension push it to the cache.
    for (const fileName of files) {
      let splitted = fileName.split('.')
      if (IMAGE_EXTENSIONS.includes(splitted[splitted.length - 1].toUpperCase())) {
        cache.images.push(splitted)
      }
    }
  }

  // Now process the users cache.
  // If the file doesn't exists, create a new one and return false.
  if (!fs.existsSync(CACHE_FILE_NAME)) {
    fs.writeFileSync(CACHE_FILE_NAME, JSON.stringify({ users: [] }))

    return false
  }

  const cacheJson = fs.readFileSync(CACHE_FILE_NAME)

  try {
    cache.users = JSON.parse(cacheJson).users
  } catch (err) {
    console.log(chalk.red(err))
    return false
  }

  return true
}

// Update the cache.
function updateCache(users) {
  return new Promise(async (resolve, reject) => {
    // Iterates over all the users.
    for (const user of users) {
      // Check if we already have image for the user.
      if (!cache.images.includes(user.id.toString())) {
        try {
          await saveImage(user.id.toString(), user.avatar)
        } catch (err) {
          console.log(chalk.red(`Image saving failed for ${user.username}. ${err}`))
        }
      }

      // Check if the user is already in the cache.
      const userIndex = _.findIndex(cache.users, { 'id:': user.id })

      // If not,
      if (userIndex === -1) {
        // simply add it.
        cache.users.push(user)
        continue
      }
      // If it's in the cache already and have to refresh it.
      // If we use the refresh it means the user data is from the API in this session so it's newer than the old one.
      if (refresh) {
        cache.users[userIndex] = user
      }
    }

    // Write the cache to file.
    fs.writeFile(CACHE_FILE_NAME, JSON.stringify({ users: cache.users }), err => {
      if (err) reject(err)
      else resolve()
    })
  })
}

// Save the results to file.
function save(data, callback) {
  // Render the template.
  ejs.renderFile('template.ejs', {
    data: data,
    style: style,
  },
  (err, res) => {
    if (err) {
      callback(err)
    }
    // First create the necessary directories if they aren't exist yet.
    if (!fs.existsSync('output')) {
      fs.mkdirSync('output')
    }
    if (!fs.existsSync(path.join('output', 'images'))) {
      fs.mkdirSync(path.join('output', 'images'))
    }
    if (!fs.existsSync(path.join('output', 'jquery'))) {
      fs.mkdirSync(path.join('output', 'jquery'))
    }
    if (!fs.existsSync(path.join('output', 'qtip2'))) {
      fs.mkdirSync(path.join('output', 'qtip2'))
    }
    if (!fs.existsSync(path.join('output', 'cytoscape'))) {
      fs.mkdirSync(path.join('output', 'cytoscape'))
    }
    if (!fs.existsSync(path.join('output', 'cytoscape-qtip'))) {
      fs.mkdirSync(path.join('output', 'cytoscape-qtip'))
    }

    // Then copy the files into them.
    for (const file of fs.readdirSync(IMAGES_DIR_NAME)) {
      try {
        fs.copyFileSync(path.join(IMAGES_DIR_NAME, file),
                        path.join('output', 'images', file))
      } catch (err) {
        console.log(chalk.red('Cannot copy file:' + file))
      }
    }

    fs.copyFileSync(path.join(__dirname, 'node_modules', 'jquery', 'dist', 'jquery.min.js'),
                    path.join('output', 'jquery', 'jquery.min.js'))
    fs.copyFileSync(path.join(__dirname, 'node_modules', 'qtip2', 'dist', 'jquery.qtip.min.js'),
                    path.join('output', 'qtip2', 'jquery.qtip.min.js'))
    fs.copyFileSync(path.join(__dirname, 'node_modules', 'qtip2', 'dist', 'jquery.qtip.min.css'),
                    path.join('output', 'qtip2', 'jquery.qtip.min.css'))
    fs.copyFileSync(path.join(__dirname, 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js'),
                    path.join('output', 'cytoscape', 'cytoscape.min.js'))
    fs.copyFileSync(path.join(__dirname, 'node_modules', 'cytoscape-qtip', 'cytoscape-qtip.js'),
                    path.join('output', 'cytoscape-qtip', 'cytoscape-qtip.js'))

    // Finally write the rendered template to a file.
    fs.writeFileSync(path.join('output', 'index.html'), res)

    callback()
  })
}

// Save the image from the given URL.
function saveImage(id, url) {
  return new Promise((resolve, reject) => {
    // Options for the content type check request.
    const options = {
      method: 'GET',
      uri: url,
      resolveWithFullResponse: true,
    }

    // First get the content type for the image.
    request(options)
      .then(res => {
        const contentType = res.headers['content-type'].split('/').pop()
        requestLegacy(url).pipe(fs.createWriteStream(`${IMAGES_DIR_NAME}/${id}.${contentType}`))
          .on('finish', resolve())
      })
      .catch(err => {
        reject(err)
      })
    })
}

// Get user informations from the GitHub API or the local cache.
async function getUserData(username) {
  let user

  try {
    // If no need to refresh the user and we can use the cache
    if (!refresh && cache.users.length) {
      // search for the user.
      const userObj = _.find(cache.users, { 'username': username })
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
        user.followers = -1
        console.log(chalk.green('User ') + user.username + chalk.green(' followers has been skipped. ') + user.followers_count)
      }
    }

    // Get the following users, if it's any and less than the limit.
    if (user.following_count) {
      if (config.followingsLimit < 0 || user.following_count < config.followingsLimit) {
        user.followings = await getFollowingUsers(username)
      } else {
        user.followings = -1
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

  // Set the refresh global variable.
  refresh = args.refresh

  // Use the cache if at least one user in it.
  const isCacheLoaded = loadCache()

  let data = null

  // Create the express app.
  const server = express()
  // With ejs template engine.
  server.set('view engine', 'ejs')
  // Views in the root dir. Sorry too small project for structuring better.
  server.set('views', path.join(__dirname))
  // Bind paths for host.
  server.use('/images', express.static(path.join(__dirname, IMAGES_DIR_NAME)))
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

  getAllUser(args.user, args.depth)
    .then(async users => {
      // Update the cache in the background.
      console.log(chalk.green('Updating cache in the background. Please do not exit!'))

      const updateResult = await updateCache(users)

      updateResult ? console.log(chalk.red('Error during the cache update.', updateResult)) :
                     console.log(chalk.green('Cache successfully updated.'))

      data = users ? prepareData(users) : [{ data: { id: 'ERR', username: 'No user :(' }}]

      if (args.save) {
        save(data, err => {
          if (err) console.log(chalk.red('Error during the saving.', err))
          else console.log(chalk.green('Successfully saved.'))
        })

        process.exit()
      }

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