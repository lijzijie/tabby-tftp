const webpack = require('webpack')
const config = require('../webpack.config')

const compiler = webpack(config)
const report = (error, stats) => {
    if (error) {
        console.error(error.stack || error)
        process.exitCode = 1
        return
    }
    const output = stats.toString({
        colors: true,
        assets: true,
        chunks: false,
        modules: false,
    })
    if (output) console.log(output)
    if (stats.hasErrors()) process.exitCode = 1
}

if (process.argv.includes('--watch')) {
    compiler.watch({}, report)
} else {
    compiler.run((error, stats) => {
        report(error, stats)
        compiler.close(closeError => {
            if (closeError) {
                console.error(closeError)
                process.exitCode = 1
            }
        })
    })
}
