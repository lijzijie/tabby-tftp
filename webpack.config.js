const path = require('path')

module.exports = {
    mode: 'production',
    target: 'electron-renderer',
    entry: './src/index.ts',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'index.js',
        libraryTarget: 'commonjs2',
        clean: true,
    },
    devtool: 'source-map',
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: 'ts-loader',
            },
        ],
    },
    externals: [
        ({ request }, callback) => {
            if (!request) {
                return callback()
            }
            if (
                request === 'rxjs' ||
                request.startsWith('rxjs/') ||
                request.startsWith('@angular/') ||
                request.startsWith('@ng-bootstrap/') ||
                request.startsWith('tabby-') ||
                ['dgram', 'dns', 'buffer', 'fs', 'path', 'os', '@electron/remote'].includes(request)
            ) {
                return callback(null, `commonjs ${request}`)
            }
            callback()
        },
    ],
}
