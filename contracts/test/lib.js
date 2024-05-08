const { exec } = require("child_process"); // Importing exec from child_process

const adminKeyName = "admin"

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function delay() {
    await sleep(1000)
}

async function fundAddress(addr, amount="10000000000000000000") {
    const result = await evmSend(addr, adminKeyName, amount)
    await delay()
    return result
}

async function evmSend(addr, fromKey, amount="100000000000000000000000") {
    const output = await execute(`seid tx evm send ${addr} ${amount} --from ${fromKey} -b block -y`);
    return output.replace(/.*0x/, "0x").trim()
}

async function bankSend(toAddr, fromKey, amount="100000000000", denom="usei") {
    const result = await execute(`seid tx bank send ${fromKey} ${toAddr} ${amount}${denom} -b block --fees 20000usei -y`);
    await delay()
    return result
}

async function fundSeiAddress(seiAddr, amount="100000000000", denom="usei") {
    return await execute(`seid tx bank send ${adminKeyName} ${seiAddr} ${amount}${denom} -b block --fees 20000usei -y`);
}

async function getSeiBalance(seiAddr, denom="usei") {
    const result = await execute(`seid query bank balances ${seiAddr} -o json`);
    const balances = JSON.parse(result)
    for(let b of balances.balances) {
        if(b.denom === denom) {
            return parseInt(b.amount, 10)
        }
    }
    return 0
}

async function importKey(name, keyfile) {
    try {
        return await execute(`seid keys import ${name} ${keyfile}`, `printf "12345678\\n12345678\\n"`)
    } catch(e) {
        console.log("not importing key (skipping)")
        console.log(e)
    }
}

async function getNativeAccount(keyName) {
    await associateKey(adminKeyName)
    const seiAddress = await getKeySeiAddress(keyName)
    await fundSeiAddress(seiAddress)
    await delay()
    const evmAddress = await getEvmAddress(seiAddress)
    return {
        seiAddress,
        evmAddress
    }
}

async function getAdmin() {
    await associateKey(adminKeyName)
    return await getNativeAccount(adminKeyName)
}

async function getKeySeiAddress(name) {
    return (await execute(`seid keys show ${name} -a`)).trim()
}

async function associateKey(keyName) {
    try {
        await execute(`seid tx evm associate-address --from ${keyName} -b block`)
        await delay()
    }catch(e){
        console.log("skipping associate")
    }
}

function getEventAttribute(response, type, attribute) {
    if(!response.logs || response.logs.length === 0) {
        throw new Error("logs not returned")
    }

    for(let evt of response.logs[0].events) {
        if(evt.type === type) {
            for(let att of evt.attributes) {
                if(att.key === attribute) {
                    return att.value;
                }
            }
        }
    }
    throw new Error("attribute not found")
}

async function storeWasm(path) {
    const command = `seid tx wasm store ${path} --from ${adminKeyName} --gas=5000000 --fees=1000000usei -y --broadcast-mode block -o json`
    const output = await execute(command);
    const response = JSON.parse(output)
    return getEventAttribute(response, "store_code", "code_id")
}
async function getPointerForCw20(cw20Address) {
    const command = `seid query evm pointer CW20 ${cw20Address} -o json`
    const output = await execute(command);
    return JSON.parse(output);
}

async function getPointerForCw721(cw721Address) {
    const command = `seid query evm pointer CW721 ${cw721Address} -o json`
    const output = await execute(command);
    return JSON.parse(output);
}

async function deployErc20PointerForCw20(provider, cw20Address) {
    const command = `seid tx evm call-precompile pointer addCW20Pointer ${cw20Address} --from=admin -b block`
    const output = await execute(command);
    const txHash = output.replace(/.*0x/, "0x").trim()
    let attempt = 0;
    while(attempt < 10) {
        const receipt = await provider.getTransactionReceipt(txHash);
        if(receipt) {
            return (await getPointerForCw20(cw20Address)).pointer
        }
        await sleep(500)
        attempt++
    }
    throw new Error("contract deployment failed")
}

async function deployErc721PointerForCw721(provider, cw721Address) {
    const command = `seid tx evm call-precompile pointer addCW721Pointer ${cw721Address} --from=admin -b block`
    const output = await execute(command);
    const txHash = output.replace(/.*0x/, "0x").trim()
    let attempt = 0;
    while(attempt < 10) {
        const receipt = await provider.getTransactionReceipt(txHash);
        if(receipt) {
            return (await getPointerForCw721(cw721Address)).pointer
        }
        await sleep(500)
        attempt++
    }
    throw new Error("contract deployment failed")
}

async function deployWasm(path, adminAddr, label, args = {}) {
    const codeId = await storeWasm(path)
    return await instantiateWasm(codeId, adminAddr, label, args)
}

async function instantiateWasm(codeId, adminAddr, label, args = {}) {
    const jsonString = JSON.stringify(args).replace(/"/g, '\\"');
    const command = `seid tx wasm instantiate ${codeId} "${jsonString}" --label ${label} --admin ${adminAddr} --from ${adminKeyName} --gas=5000000 --fees=1000000usei -y --broadcast-mode block -o json`;
    const output = await execute(command);
    const response = JSON.parse(output);
    return getEventAttribute(response, "instantiate", "_contract_address");
}


async function getSeiAddress(evmAddress) {
    const command = `seid q evm sei-addr ${evmAddress} -o json`
    const output = await execute(command);
    const response = JSON.parse(output)
    return response.sei_address
}

async function getEvmAddress(seiAddress) {
    const command = `seid q evm evm-addr ${seiAddress} -o json`
    const output = await execute(command);
    const response = JSON.parse(output)
    return response.evm_address
}


async function deployEvmContract(name, args=[]) {
    const Contract = await ethers.getContractFactory(name);
    const contract = await Contract.deploy(...args);
    await contract.waitForDeployment()
    return contract;
}

async function setupSigners(signers) {
    const result = []
    for(let signer of signers) {
        const evmAddress = await signer.getAddress();
        await fundAddress(evmAddress);
        await delay()
        const resp = await signer.sendTransaction({
            to: evmAddress,
            value: 0
        });
        await resp.wait()
        const seiAddress = await getSeiAddress(evmAddress);
        result.push({
            seiAddress,
            evmAddress,
            signer,
        })
    }
    return result;
}

async function queryWasm(contractAddress, operation, args={}){
    const jsonString = JSON.stringify({ [operation]: args }).replace(/"/g, '\\"');
    const command = `seid query wasm contract-state smart ${contractAddress} "${jsonString}" --output json`;
    const output = await execute(command);
    return JSON.parse(output)
}

async function executeWasm(contractAddress, msg, coins = "0usei") {
    const jsonString = JSON.stringify(msg).replace(/"/g, '\\"'); // Properly escape JSON string
    const command = `seid tx wasm execute ${contractAddress} "${jsonString}" --amount ${coins} --from ${adminKeyName} --gas=5000000 --fees=1000000usei -y --broadcast-mode block -o json`;
    const output = await execute(command);
    return JSON.parse(output);
}

async function execute(command, interaction=`printf "12345678\\n"`){
    return new Promise((resolve, reject) => {
        // Check if the Docker container 'sei-node-0' is running
        exec("docker ps --filter 'name=sei-node-0' --format '{{.Names}}'", (error, stdout, stderr) => {
            if (stdout.includes('sei-node-0')) {
                // The container is running, modify the command to execute inside Docker
                command = command.replace(/\.\.\//g, "/sei-protocol/sei-chain/");
                const dockerCommand = `docker exec sei-node-0 /bin/bash -c 'export PATH=$PATH:/root/go/bin:/root/.foundry/bin && ${interaction} | ${command}'`;
                execCommand(dockerCommand, resolve, reject);
            } else {
                // The container is not running, execute command normally
                execCommand(command, resolve, reject);
            }
        });
    });
}

function execCommand(command, resolve, reject) {
    exec(command, (error, stdout, stderr) => {
        if (error) {
            reject(error);
            return;
        }
        if (stderr) {
            reject(new Error(stderr));
            return;
        }
        resolve(stdout);
    });
}

async function waitForReceipt(txHash) {
    let receipt = await ethers.provider.getTransactionReceipt(txHash)
    while(!receipt) {
        await delay()
        receipt = await ethers.provider.getTransactionReceipt(txHash)
    }
    return receipt
}

module.exports = {
    fundAddress,
    fundSeiAddress,
    getSeiBalance,
    storeWasm,
    deployWasm,
    instantiateWasm,
    execute,
    getSeiAddress,
    getEvmAddress,
    queryWasm,
    executeWasm,
    getAdmin,
    setupSigners,
    deployEvmContract,
    deployErc20PointerForCw20,
    deployErc721PointerForCw721,
    importKey,
    getNativeAccount,
    associateKey,
    delay,
    bankSend,
    evmSend,
    waitForReceipt,
};