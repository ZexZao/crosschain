#pragma once

#include <eosio/asset.hpp>
#include <eosio/crypto.hpp>
#include <eosio/eosio.hpp>
#include <eosio/singleton.hpp>
#include <algorithm>
#include <tuple>
#include <vector>

using namespace eosio;

class [[eosio::contract("mercuryvault")]] mercuryvault : public contract {
public:
    using contract::contract;

    struct transfer_item {
        checksum256 deposit_id;
        name receiver;
        asset quantity;
        EOSLIB_SERIALIZE(transfer_item, (deposit_id)(receiver)(quantity))
    };

    [[eosio::action]] void init(checksum256 chain_id, name token_contract, uint16_t threshold,
                                std::vector<public_key> operators);
    [[eosio::action]] void transfer(checksum256 batch_id, std::vector<transfer_item> transfers,
                                    std::vector<signature> signatures);

private:
    struct [[eosio::table("config")]] config_row {
        checksum256 chain_id;
        name token_contract;
        uint16_t threshold;
        std::vector<public_key> operators;
    };
    using config_singleton = singleton<"config"_n, config_row>;

    struct [[eosio::table]] completed_row {
        uint64_t key;
        checksum256 object_id;
        uint64_t primary_key() const { return key; }
        checksum256 by_object() const { return object_id; }
    };
    using completed_table = multi_index<
        "completed"_n,
        completed_row,
        indexed_by<"byobject"_n, const_mem_fun<completed_row, checksum256, &completed_row::by_object>>>;

    bool seen(const completed_table& table, const checksum256& object_id) const;
    void remember(completed_table& table, const checksum256& object_id);
};
