#include "mercuryvault.hpp"

void mercuryvault::init(checksum256 chain_id, name token_contract, uint16_t threshold,
                        std::vector<public_key> operators) {
    require_auth(get_self());
    check(token_contract.value != 0, "bad token contract");
    check(!operators.empty(), "operators required");
    check(operators.size() % 2 == 1, "MERCURY requires n=2f+1 operators");
    check(threshold == operators.size() / 2 + 1, "threshold must be f+1");
    config_singleton config(get_self(), get_self().value);
    config.set(config_row{chain_id, token_contract, threshold, operators}, get_self());
}

bool mercuryvault::seen(const completed_table& table, const checksum256& object_id) const {
    const auto& index = table.get_index<"byobject"_n>();
    return index.find(object_id) != index.end();
}

void mercuryvault::remember(completed_table& table, const checksum256& object_id) {
    table.emplace(get_self(), [&](auto& row) {
        row.key = table.available_primary_key();
        row.object_id = object_id;
    });
}

void mercuryvault::transfer(checksum256 batch_id, std::vector<transfer_item> transfers,
                            std::vector<signature> signatures) {
    config_singleton config_store(get_self(), get_self().value);
    check(config_store.exists(), "vault is not initialized");
    const auto config = config_store.get();
    check(!transfers.empty(), "empty batch");
    check(signatures.size() >= config.threshold, "signatures below threshold");

    const auto packed = pack(std::make_tuple(config.chain_id, get_self(), batch_id, transfers));
    const checksum256 digest = sha256(packed.data(), packed.size());
    std::vector<public_key> recovered;
    for (const auto& signature : signatures) {
        const auto key = recover_key(digest, signature);
        check(std::find(config.operators.begin(), config.operators.end(), key) != config.operators.end(),
              "unknown TEE signer");
        check(std::find(recovered.begin(), recovered.end(), key) == recovered.end(), "duplicate TEE signer");
        recovered.push_back(key);
    }

    completed_table completed(get_self(), get_self().value);
    check(!seen(completed, batch_id), "batch replay");
    remember(completed, batch_id);
    for (const auto& item : transfers) {
        check(item.receiver.value != 0 && item.quantity.amount > 0, "bad transfer");
        check(!seen(completed, item.deposit_id), "deposit replay");
        remember(completed, item.deposit_id);
        action(
            permission_level{get_self(), "active"_n},
            config.token_contract,
            "transfer"_n,
            std::make_tuple(get_self(), item.receiver, item.quantity, std::string("MERCURY cross-chain exchange"))
        ).send();
    }
}

EOSIO_DISPATCH(mercuryvault, (init)(transfer))
