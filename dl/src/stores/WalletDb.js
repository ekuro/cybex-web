import iDB from "../idb-instance";
import key from "../common/key_utils"
import idb_helper from "../idb-helper"

import Immutable from "immutable";

import BaseStore from "./BaseStore"
import PrivateKeyStore from "./PrivateKeyStore"

import {WalletTcomb, PrivateKeyTcomb} from "./tcomb_structs";
import PrivateKey from "../ecc/key_private"
import ApplicationApi from "../rpc_api/ApplicationApi"

var aes_private_map = {}
var application_api = new ApplicationApi()

class WalletDb {
    
    constructor() {
        this.secret_server_token = "secret_server_token";
        this.wallets = Immutable.Map();
    }
    
    getWallet(wallet_public_name) {
        return this.wallets.get(wallet_public_name)
    }
    
    getCurrentWallet() {
        if( ! this.current_wallet) {
            if(this.wallets.count())
                this.current_wallet = this.wallets.first().public_name
        }
        return this.current_wallet
    }
    
    getBrainKey(wallet_public_name) {
        var wallet = this.wallets.get(wallet_public_name)
        if ( ! wallet)
            throw new Error("missing wallet " + wallet_public_name)
        
        var aes_private = aes_private_map[wallet_public_name]
        if ( ! aes_private)
            throw new Error("wallet locked " + wallet_public_name)
        
        if ( ! wallet.encrypted_brainkey)
            throw new Error("wallet does not have a brainkey")
        
        var brainkey_plaintext = aes_private.decryptHexToText(
            wallet.encrypted_brainkey
        )
        try {
            key.aes_private(
                brainkey_plaintext + this.secret_server_token,
                wallet.brainkey_checksum
            )
        } catch(e) {
            throw new Error('Brainkey checksum mis-match')
        }
        return brainkey_plaintext
    }
    
    onLock(wallet_public_name) {
        delete aes_private_map[wallet_public_name]
    }
    
    isLocked(wallet_public_name) {
        return aes_private_map[wallet_public_name] ? false : true
    }
    
    validatePassword(
        wallet_public_name,
        password,
        unlock = false
    ) {
        var wallet = this.wallets.get(wallet_public_name)
        if ( ! wallet)
            return false
        
        try {
            var aes_private = key.aes_private(
                password + this.secret_server_token,
                wallet.password_checksum
            )
            if(unlock) {
                aes_private_map[wallet_public_name] = aes_private
                this.current_wallet = wallet_public_name
            }
        } catch(e) {
            console.log('password error', e)
        }
    }
    
    transaction(resolve, reject) {
        let transaction = iDB.instance().db().transaction(
            ["wallets", "private_keys"], "readwrite"
        )
        transaction.onerror = e => {
            reject(e.target.error.message)
        }
        transaction.oncomplete = e => {
            resolve()
        }
        return transaction
    }
    
    saveKey({
        password_aes_private,
        wallet_public_name,
        wallet_id,
        private_key,
        brainkey_pos,
        transaction
    }) {
        if(password_aes_private == void 0)
            password_aes_private = aes_private_map[
                wallet_public_name
            ]
        
        var private_cipherhex =
            password_aes_private.encryptToHex(
                private_key.toBuffer()
            )
        
        var public_key = private_key.toPublicKey()
        var private_key_object = {
            wallet_id,
            brainkey_pos,
            encrypted_key: private_cipherhex,
            pubkey: public_key.toBtsPublic()
        }
        return PrivateKeyStore.onAddKey(
            private_key_object, transaction
        )
    }
    
    incrementBrainKeySequence({
        wallet_public_name,
        transaction
    }) {
        return new Promise((resolve, reject) => {
            var wallet = this.wallets.get(wallet_public_name)
            if ( ! wallet) {
                reject("missing wallet " + wallet_public_name)
                return
            }
            // https://github.com/gcanti/tcomb/issues/110
            //var new_wallet = WalletTcomb.update(wallet, {
            //    brainkey_sequence: {'$set': wallet.brainkey_sequence + 1}
            //})
            var new_wallet = wallet
            wallet.brainkey_sequence = wallet.brainkey_sequence + 1
            var wallet_store = transaction.objectStore("wallets")
            return idb_helper.promise(
                wallet_store.put(new_wallet)
            ).then( () => {
                // Update RAM
                this.wallets.set(
                    new_wallet.public_name,
                    new_wallet
                )
                resolve()
            }).catch( error => { reject(error) })
        })
    }
    
    onCreateWallet({
        wallet_public_name = "default", 
        password_plaintext,
        brainkey_plaintext,
        private_wifs  = [],
        unlock = false,
        transaction
    }) {
        return new Promise( (resolve, reject) => {
            if(this.wallets.get(wallet_public_name)) {
                reject("wallet exists")
                return
            }
            var password = key.aes_checksum(
                password_plaintext + this.secret_server_token
            )
            
            // When deleting then re-adding a brainkey this checksum
            // is used to ensure it is the correct brainkey.
            var brainkey_checksum = key.aes_checksum(
                brainkey_plaintext + this.secret_server_token
            ).checksum
            
            var brainkey_cipherhex = password.aes_private.encryptToHex(
                brainkey_plaintext
            )
            
            let wallet = {
                public_name: wallet_public_name,
                password_checksum: password.checksum,
                encrypted_brainkey: brainkey_cipherhex,
                brainkey_checksum,
                brainkey_sequence: 0
            }
            
            return idb_helper.add(
                transaction.objectStore("wallets"), wallet, () => {
                    try {
                        var promises = []
                        for(let wif of private_wifs) {
                            var private_key = PrivateKey.fromWif(wif)
                            var promise = this.saveKey(
                                password.aes_private,
                                wallet.public_name,
                                wallet.id,
                                private_key,
                                null, //brainkey_pos
                                transaction
                            )
                            promises.push(promise)
                        }
                        
                        return Promise.all(promises).then( ()=> {
                            this.wallets = this.wallets.set(
                                wallet.public_name,
                                wallet//WalletTcomb(wallet)
                            )
                            if(unlock) {
                                aes_private_map[wallet_public_name] =
                                    password.aes_private
                            
                                this.current_wallet = wallet.public_name
                            }
                            resolve()
                        }).catch( error => {
                            reject(error)
                        })
                    } catch(e) {
                        reject(e)
                    }
                }
            )
        })
    }
    
    saveKeys(params){
        return new Promise((resolve, reject) => {
            var {wallet, private_keys, transaction} = params
            var private_key_promises = []
            for(let private_key_record of private_keys) {
                private_key_promises.push(
                    this.saveKey({
                        password_aes_private: null,
                        wallet_public_name: wallet.public_name,
                        wallet_id: wallet.id,
                        private_key: private_key_record.privkey,
                        brainkey_pos: private_key_record.sequence,
                        transaction
                    })
                )
            }
            Promise.all(private_key_promises).then( ()=> {
                resolve()
            }).catch( error => {
                reject(error)
            })
        })
    }
    
    /*
    onDeleteWallet(wallet_public_name = "default") {
        var wallet = this.wallets.get(wallet_public_name)
        if(!wallet) {
            reject("no match")
            return false
        }
        let transaction = iDB.instance().db().transaction(
            ["wallets", "private_keys"],
            "readwrite"
        );
        transaction.onerror = e => {
            reject(e.target.error.message)
        }
        PrivateKeyStore.deleteByWalletId(wallet.id, transaction).then(()=>{
            let wallet_store = transaction.objectStore("wallets");
            let request = wallet_store.delete(wallet.id);
            request.onsuccess = () => {
                delete aes_private_map[wallet_public_name]
                this.wallets = this.wallets.delete(wallet_public_name)
                if(this.wallets.get(wallet_public_name))
                    console.log("DEBUG delete failed")
                
                eventEmitter.emitChange()
            }
            request.onerror = (e) => {
                console.log("ERROR!!! deleteWallet - ", e.target.error.message, value);
                reject(e.target.error.message);
            }
        }).catch( error => {reject(error)})
        return false
    }*/
    

    /*
    validateBrainkey(
        wallet,
        brain_key
    ) {
        if ( ! wallet)
            throw new Error("wrong password")
        
        if(! brain_key || typeof brain_key != 'string')
            throw new Error("required: brain_key")
        
        if(! secret_server_token || typeof password != 'string')
            throw new Error("required: secret_server_token")
        
        if ( ! wallet.brainkey_checksum)
            throw new Error("wrong password")
        
        var aes_private = key.aes_private(
            brain_key + secret_server_token,
            wallet.brainkey_checksum
        )
    }
    */
    // delete_brainkey
    
    loadDbData() {
        var map = this.wallets.asMutable()
        return idb_helper.cursor("wallets", cursor => {
            if( ! cursor) {
                this.wallets = map.asImmutable()
                return
            }
            var wallet = cursor.value//WalletTcomb(cursor.value)
            map.set(wallet.public_name, wallet)
            cursor.continue()
        });
    }
    
}

module.exports = new WalletDb()

function reject(error) {
    console.error( "----- WalletDb reject error -----", error)
    throw new Error(error)
}   
