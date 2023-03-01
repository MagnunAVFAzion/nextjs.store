const { copyFileSync } = require('fs')

const FILES_TO_COPY = {
  '@vtex/client-cms': {
    src: 'patchs/vtex/client-cms.cjs.production.min.js',
    dest: 'node_modules/@vtex/client-cms/dist/client-cms.cjs.production.min.js',
  },
  '@envelop/core': {
    src: 'patchs/envelop/index.mjs',
    dest: 'node_modules/@envelop/core/index.mjs',
  },
}

const copyFiles = () => {
  Object.keys(FILES_TO_COPY).forEach((pkgName) => {
    pkg = FILES_TO_COPY[pkgName]

    console.log(`* Patching ${pkgName} ...`)

    copyFileSync(pkg.src, pkg.dest)

    console.log('Done !')
  })
}

const main = async () => {
  try {
    console.log('\n=> Running prebuild actions ...')

    copyFiles()

    console.log('Prebuild done with success !\n')
  } catch (error) {
    console.log('Error in prebuild: ', error)
  }
}

main()
